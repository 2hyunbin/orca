import { constants } from 'node:os'
import { describe, expect, it } from 'vitest'
import { execFileCapture } from './exec-file-capture'
import { lowPriorityGitCommand } from './low-priority-git-command'
import type { ResolvedCommand } from './wsl-command-resolution'

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
      expect(result.args).toEqual([
        '-d',
        'Ubuntu',
        '--exec',
        '/usr/bin/nice',
        '-n',
        '10',
        ...guestArgs
      ])
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
})
