import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWindowsWslUncPath } from '../../../shared/wsl-paths'
import { makeSkillHome, removeSkillHomes, type SkillHome } from './skill-home.test-support'

const DISTRO = 'Ubuntu'
const runs: { script: string; args: readonly string[] }[] = []

// Why a local `sh`: the guest scripts are plain POSIX, so they run here as they would in WSL.
vi.mock('../../wsl/wsl-runner', () => ({
  runWslProcess: vi.fn(async (spec: { script: string; args: readonly string[] }) => {
    runs.push(spec)
    const result = spawnSync('sh', ['-c', spec.script, '--', ...spec.args], { encoding: 'utf8' })
    return {
      environmentResolved: true,
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false
    }
  })
}))

const { createWslBundledSkillFilesystem, WSL_WRITE_CHUNK_CHARS } = await import('./wsl-filesystem')

const unc = (guestPath: string): string => toWindowsWslUncPath(guestPath, DISTRO)

let home: SkillHome
let filesystem: ReturnType<typeof createWslBundledSkillFilesystem>

beforeEach(async () => {
  runs.length = 0
  home = await makeSkillHome()
  filesystem = createWslBundledSkillFilesystem({
    distro: DISTRO,
    homeDirectory: unc(home.home)
  })
})

afterEach(async () => {
  await removeSkillHomes()
})

describe('createWslBundledSkillFilesystem', () => {
  it('observes every path in one guest call, keyed by the caller’s own spelling', async () => {
    const skill = join(home.home, '.agents', 'skills', 'orca-cli')
    await mkdir(skill, { recursive: true })
    const crlf = Buffer.from('---\r\nname: orca-cli\r\n---\r\nhé\r\n', 'utf8')
    await writeFile(join(skill, 'SKILL.md'), crlf)
    await writeFile(join(skill, '.DS_Store'), 'x')
    const claude = join(home.home, '.claude', 'skills')
    await mkdir(claude, { recursive: true })
    await symlink('../../.agents/skills/orca-cli', join(claude, 'orca-cli'))
    await symlink('../../.agents/skills/gone', join(claude, 'broken'))
    await writeFile(join(claude, 'note'), 'x')
    const paths = [skill, join(claude, 'orca-cli'), join(claude, 'broken'), join(claude, 'note')]
      .concat(join(claude, 'missing'))
      .map(unc)

    const seen = await filesystem.observe(paths)

    expect(runs).toHaveLength(1)
    expect(seen.get(paths[0])).toMatchObject({
      kind: 'directory',
      entries: expect.arrayContaining([
        { name: 'SKILL.md', kind: 'file' },
        { name: '.DS_Store', kind: 'file' }
      ]),
      skillFile: crlf
    })
    expect(seen.get(paths[1])).toMatchObject({
      kind: 'symlink',
      linkTarget: '../../.agents/skills/orca-cli',
      linkRealPath: unc(skill)
    })
    expect(seen.get(paths[2])).toMatchObject({ kind: 'symlink', linkRealPath: null })
    expect(seen.get(paths[3])).toMatchObject({ kind: 'file' })
    expect(seen.get(paths[4])).toEqual({ kind: 'missing', mtimeMs: null })
  })

  it('writes exact bytes with readable modes whatever the guest umask', async () => {
    const stage = join(home.home, '.agents', 'skills', '.orca-cli.orca-stage-1')
    const text = '---\nname: orca-cli\n---\nCafé ’ — ok\n'

    await filesystem.writeFolder(unc(stage), [{ path: 'SKILL.md', text }])

    expect(await readFile(join(stage, 'SKILL.md'), 'utf8')).toBe(text)
    expect((await lstat(stage)).mode & 0o777).toBe(0o755)
    expect((await lstat(join(stage, 'SKILL.md'))).mode & 0o777).toBe(0o644)
  })

  it('writes a file larger than one command line in chunks, byte for byte', async () => {
    const stage = join(home.home, '.agents', 'skills', '.big.orca-stage-1')
    const text = `---\nname: big\n---\n${'Café ’ — line\n'.repeat(4000)}`

    await filesystem.writeFolder(unc(stage), [{ path: 'SKILL.md', text }])

    expect(await readFile(join(stage, 'SKILL.md'), 'utf8')).toBe(text)
    expect((await lstat(join(stage, 'SKILL.md'))).mode & 0o777).toBe(0o644)
    expect(runs.length).toBeGreaterThan(2)
    for (const run of runs) {
      expect(run.args.join('').length).toBeLessThanOrEqual(WSL_WRITE_CHUNK_CHARS + 1024)
    }
  })

  it('links relative to the real parent and never tightens the agent folder', async () => {
    const shared = join(home.home, '.agents', 'skills', 'orca-cli')
    await mkdir(shared, { recursive: true })
    const claudeRoot = join(home.home, '.claude', 'skills')
    await mkdir(claudeRoot, { recursive: true, mode: 0o755 })

    await filesystem.createLink(unc(shared), unc(join(claudeRoot, 'orca-cli')))

    expect(await readlink(join(claudeRoot, 'orca-cli'))).toBe('../../.agents/skills/orca-cli')
    expect((await lstat(claudeRoot)).mode & 0o777).toBe(0o755)
    await expect(
      filesystem.createLink(unc(shared), unc(join(claudeRoot, 'orca-cli')))
    ).rejects.toThrow('skill-install-wsl-guest-operation-failed')
  })

  it('refuses to write outside the agent skill roots and backups', async () => {
    await expect(
      filesystem.writeFolder(unc(join(home.home, 'Documents', 'x')), [{ path: 'a', text: 'b' }])
    ).rejects.toThrow('skill-install-wsl-path-outside-root')
    await expect(
      filesystem.createLink(unc(join(home.home, '.agents', 'skills', 'x')), unc('/etc/x'))
    ).rejects.toThrow('skill-install-wsl-path-outside-root')
    expect(runs).toHaveLength(0)

    // Swap ensures the backups root itself before moving a copy into it.
    await filesystem.ensureDirectory(unc(join(home.home, '.agents', '.orca-skill-backups')))
    expect((await lstat(join(home.home, '.agents', '.orca-skill-backups'))).isDirectory()).toBe(
      true
    )
    await expect(filesystem.ensureDirectory(unc(join(home.home, '.agents')))).rejects.toThrow(
      'skill-install-wsl-path-outside-root'
    )
  })

  it('resolves real paths and writability in the guest', async () => {
    const shared = join(home.home, '.agents', 'skills')
    await mkdir(shared, { recursive: true })

    expect(await filesystem.realpath(unc(shared))).toBe(unc(shared))
    expect(await filesystem.realpath(unc(join(shared, 'missing')))).toBeNull()
    expect(await filesystem.canWrite(unc(join(shared, 'not-yet', 'deeper')))).toBe(true)
  })
})
