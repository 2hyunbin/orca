import { access, mkdtemp, rm, symlink } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileCapture } from './exec-file-capture'
import { lowPriorityGitCommand } from './low-priority-git-command'
import type { ResolvedCommand } from './wsl-command-resolution'
import { resolveCommandOnLocalPath } from '../../ipc/command-path-resolver'

const command: ResolvedCommand = {
  binary: '/git with spaces/git',
  args: ['-C', '/repo with spaces', 'maintenance', 'run'],
  cwd: '/repo with spaces',
  wsl: null,
  wslMode: null
}

describe('low-priority Git execution', () => {
  it.each(['direct-git', 'login-shell', 'non-login-shell'] as const)(
    'lowers priority inside WSL for %s without reparsing arguments',
    (wslMode) => {
      const guestArgs =
        wslMode === 'direct-git' ? command.args : ['sh', '-lc', 'git maintenance run']
      const result = lowPriorityGitCommand({
        ...command,
        binary: 'wsl.exe',
        args: ['-d', 'Ubuntu', '--exec', ...guestArgs],
        wsl: { distro: 'Ubuntu', linuxPath: '/repo with spaces' },
        wslMode
      })
      expect(result.binary).toBe('wsl.exe')
      expect(result.args).toEqual(['-d', 'Ubuntu', '--exec', 'nice', '-n', '10', ...guestArgs])
      expect(result.cwd).toBe(command.cwd)
    }
  )

  it('refuses an unrecognized WSL launch instead of changing host priority alone', () => {
    expect(() =>
      lowPriorityGitCommand({
        ...command,
        args: ['--', 'git'],
        wsl: { distro: 'Ubuntu', linuxPath: '/repo' }
      })
    ).toThrow('without --exec')
  })

  it('runs a real child at reduced CPU priority and still captures its output', async () => {
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(String(require('node:os').getPriority(0))))"
    const launch = lowPriorityGitCommand({
      ...command,
      binary: process.execPath,
      args: ['-e', script]
    })
    const result = await execFileCapture(launch.binary, launch.args, {
      lowPriority: true,
      encoding: 'utf8',
      timeout: 5000
    })
    expect(Number(result.stdout)).toBeGreaterThanOrEqual(constants.priority.PRIORITY_BELOW_NORMAL)
  })

  it.skipIf(process.platform === 'win32')('resolves nice from the native child PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-nice-path-'))
    try {
      const nice = await resolveCommandOnLocalPath('nice')
      if (!nice) {
        throw new Error('The priority test requires nice on PATH')
      }
      await symlink(nice, join(directory, 'nice'))
      const launch = lowPriorityGitCommand({
        ...command,
        binary: process.execPath,
        args: ['-e', 'process.stdout.write(String(require("node:os").getPriority(0)))']
      })
      expect(launch.binary).toBe('nice')
      const result = await execFileCapture(launch.binary, launch.args, {
        encoding: 'utf8',
        env: { ...process.env, PATH: directory },
        timeout: 5000
      })
      expect(Number(result.stdout)).toBeGreaterThanOrEqual(constants.priority.PRIORITY_BELOW_NORMAL)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('does not run the child if nice is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-nice-missing-'))
    const marker = join(directory, 'child-started')
    try {
      const launch = lowPriorityGitCommand({
        ...command,
        binary: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker]
      })
      await expect(
        execFileCapture(launch.binary, launch.args, {
          env: { ...process.env, PATH: directory },
          timeout: 5000
        })
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
