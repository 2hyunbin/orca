import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installBundledSkills, previewBundledSkillInstall } from './service'
import { NAME, NEW_SOURCE, NEW_TEXT, OLD_TEXT } from './skill-home.test-support'
import { createWslBundledSkillFilesystem } from './wsl-filesystem'

/**
 * The installer against a real distro from Windows: guest links, modes and backups. Run with:
 *   ORCA_REAL_WSL_SKILL_TEST=1 pnpm vitest run src/main/skills/bundled-skill-install/wsl-filesystem.integration.test.ts
 */
const execFileAsync = promisify(execFile)
const DISTRO = process.env.ORCA_REAL_WSL_SKILL_DISTRO ?? 'Ubuntu-24.04'
const RUN_REAL_WSL = process.platform === 'win32' && process.env.ORCA_REAL_WSL_SKILL_TEST === '1'

async function guest(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'wsl.exe',
    ['-d', DISTRO, '--exec', 'sh', '-c', script, '--', ...args],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
  return stdout.trim()
}

function unc(guestPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${guestPath.replaceAll('/', '\\')}`
}

describe.runIf(RUN_REAL_WSL)('bundled skills in a real WSL home', () => {
  let state = ''
  let root = ''

  beforeAll(async () => {
    state = await mkdtemp(join(tmpdir(), 'orca-bundled-wsl-'))
    root = await guest('mktemp -d /tmp/orca-bundled-wsl.XXXXXX')
    if (!root.startsWith('/tmp/orca-bundled-wsl.')) {
      throw new Error('unexpected-wsl-root')
    }
  })

  afterAll(async () => {
    await rm(state, { recursive: true, force: true })
    if (root.startsWith('/tmp/orca-bundled-wsl.')) {
      await guest('rm -rf -- "$1"', root)
    }
  })

  async function home(name: string, seed: string): Promise<string> {
    const path = `${root}/${name}`
    await guest(`set -e; mkdir -p "$1"; cd "$1"; ${seed}`, path)
    return path
  }

  function input(path: string, options: { force?: string[]; installedOnly?: boolean } = {}) {
    return {
      destination: { scope: 'global' as const, homeDirectory: unc(path) },
      agents: ['claude' as const],
      stateDirectory: state,
      sources: [NEW_SOURCE],
      filesystem: createWslBundledSkillFilesystem({ distro: DISTRO, homeDirectory: unc(path) }),
      installedOnly: options.installedOnly ?? true,
      ...(options.force ? { force: options.force } : {})
    }
  }

  async function run(service: ReturnType<typeof input>) {
    const plan = await previewBundledSkillInstall(service)
    const result = await installBundledSkills(service, plan.planDigest)
    return { plan, result }
  }

  it('updates a released copy in place with readable modes', async () => {
    const path = await home('single', `mkdir -p .claude/skills/${NAME}; chmod 755 .claude/skills`)
    await guest(`printf '%s' "$2" > "$1/.claude/skills/${NAME}/SKILL.md"`, path, OLD_TEXT)
    const { plan, result } = await run(input(path))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['update'])
    expect(result.skills[0].ops.map((op) => op.status)).toEqual(['done'])
    const skill = `${path}/.claude/skills/${NAME}`
    await expect(guest('cat "$1"', `${skill}/SKILL.md`)).resolves.toBe(NEW_TEXT.trim())
    await expect(guest('stat -c %a "$1" "$1/SKILL.md"', skill)).resolves.toBe('755\n644')
    await expect(guest('ls -A "$1"', `${path}/.claude/skills`)).resolves.toBe(NAME)
  })

  it('updates the shared copy and keeps the agent link, without tightening the agent folder', async () => {
    const path = await home(
      'shared',
      `mkdir -p .agents/skills/${NAME} .claude/skills; chmod 755 .claude/skills; ln -s ../../.agents/skills/${NAME} .claude/skills/${NAME}`
    )
    await guest(`printf '%s' "$2" > "$1/.agents/skills/${NAME}/SKILL.md"`, path, OLD_TEXT)
    const { plan, result } = await run(input(path))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['update', 'keep'])
    expect(result.skills[0].ops.every((op) => op.status === 'done')).toBe(true)
    await expect(guest('readlink "$1"', `${path}/.claude/skills/${NAME}`)).resolves.toBe(
      `../../.agents/skills/${NAME}`
    )
    await expect(guest('stat -c %a "$1"', `${path}/.claude/skills`)).resolves.toBe('755')
  })

  it('links a new agent with a relative guest link', async () => {
    const path = await home('link', `mkdir -p .agents/skills/${NAME} .claude`)
    await guest(`printf '%s' "$2" > "$1/.agents/skills/${NAME}/SKILL.md"`, path, NEW_TEXT)
    const { plan } = await run(input(path, { installedOnly: false }))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['keep', 'link'])
    await expect(guest('readlink "$1"', `${path}/.claude/skills/${NAME}`)).resolves.toBe(
      `../../.agents/skills/${NAME}`
    )
  })

  it('replaces an edited copy only when forced, keeping a guest backup', async () => {
    const path = await home('edited', `mkdir -p .claude/skills/${NAME}`)
    const edited = `---\nname: ${NAME}\n---\nmine\n`
    await guest(`printf '%s' "$2" > "$1/.claude/skills/${NAME}/SKILL.md"`, path, edited)
    const target = unc(`${path}/.claude/skills/${NAME}`)

    expect((await run(input(path))).plan.skills[0].ops.map((op) => op.kind)).toEqual(['leave'])
    const { result } = await run(input(path, { force: [target] }))

    expect(result.skills[0].ops[0]).toMatchObject({ kind: 'replace', status: 'done' })
    await expect(guest('cat "$1"/.agents/.orca-skill-backups/*/SKILL.md', path)).resolves.toBe(
      edited.trim()
    )
  })
})
