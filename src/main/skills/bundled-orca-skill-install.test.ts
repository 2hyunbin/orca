import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BundledOrcaSkillPackage } from '../../shared/bundled-orca-skill-packages'

const OLD_TEXT = '---\nname: test-skill\ndescription: Old\n---\n\nOld body\n'
const NEW_TEXT = '---\nname: test-skill\ndescription: New\n---\n\nNew body\n'

const packages = vi.hoisted(() => {
  const value: BundledOrcaSkillPackage[] = []
  return { value }
})
vi.mock('../../shared/bundled-orca-skill-packages', () => ({
  get BUNDLED_ORCA_SKILL_PACKAGES() {
    return packages.value
  }
}))

const { bundledOrcaSkillManifest, installBundledOrcaSkills, planBundledOrcaSkills } =
  await import('./bundled-orca-skill-install')
const { listManagedSkillInstalls } = await import('./skill-install-provenance')

function entry(text: string, releasedDigests: string[] = []): BundledOrcaSkillPackage {
  return { name: 'test-skill', files: [{ path: 'SKILL.md', text }], releasedDigests }
}

const OLD_DIGEST = bundledOrcaSkillManifest(entry(OLD_TEXT)).packageDigest
const NEW_DIGEST = bundledOrcaSkillManifest(entry(NEW_TEXT)).packageDigest

const temporaryDirectories: string[] = []

async function fixture(lock: Record<string, unknown> | null) {
  const root = await mkdtemp(join(tmpdir(), 'orca-bundled-skill-test-'))
  temporaryDirectories.push(root)
  const home = join(root, 'home')
  const lockPath = join(home, '.agents', '.skill-lock.json')
  await mkdir(join(home, '.agents', 'skills'), { recursive: true })
  if (lock) {
    // Why the skills CLI's own spacing: byte-identity is asserted on what it writes.
    await writeFile(lockPath, JSON.stringify({ version: 3, skills: lock }, null, 2))
  }
  const canonical = join(home, '.agents', 'skills', 'test-skill')
  const input = {
    scope: 'global' as const,
    homeDirectory: home,
    orcaStateDirectory: join(root, 'orca-state'),
    detectedProviders: ['claude'],
    providerRootOverrides: {},
    destinationIdentity: 'global:test-host',
    hostIdentity: 'test-host',
    readLockSources: async () => {
      const { readSkillLockSources } = await import('./skill-lock-sources')
      return readSkillLockSources({ homeDir: home, stateHome: null })
    }
  }
  const lockBytes = async () => readFile(lockPath).catch(() => null)
  return { root, home, canonical, input, lockBytes, initialLock: await lockBytes() }
}

async function placeCopy(canonical: string, text: string): Promise<void> {
  await mkdir(canonical, { recursive: true })
  await writeFile(join(canonical, 'SKILL.md'), text)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('bundled Orca skill install', () => {
  it('installs a fresh copy, aliases agent homes, and keeps it out of shared installs', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { root, home, canonical, input, lockBytes, initialLock } = await fixture(null)

    const [result] = await installBundledOrcaSkills(['test-skill'], input)

    expect(result.status).toBe('installed')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect((await lstat(join(home, '.claude', 'skills', 'test-skill'))).isSymbolicLink()).toBe(true)
    expect(await listManagedSkillInstalls(join(root, 'orca-state', 'skill-installs'))).toEqual([])
    expect(await lockBytes()).toEqual(initialLock)
  })

  it('replaces an earlier Orca version the skills.sh lock attributes to stablyai/orca', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { canonical, input, lockBytes, initialLock } = await fixture({
      'test-skill': { source: 'stablyai/orca', sourceType: 'github' },
      'my-own': { source: 'acme/skills', sourceType: 'github' }
    })
    await placeCopy(canonical, OLD_TEXT.replace(/\n/g, '\r\n'))

    const [result] = await installBundledOrcaSkills(['test-skill'], input)

    expect(result.status).toBe('updated')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await lockBytes()).toEqual(initialLock)
  })

  it('reports a locally edited copy as a conflict and leaves it alone', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { canonical, input, lockBytes, initialLock } = await fixture({
      'test-skill': { source: 'stablyai/orca' }
    })
    const edited = `${OLD_TEXT}\nMy own notes\n`
    await placeCopy(canonical, edited)

    const [result] = await installBundledOrcaSkills(['test-skill'], input)

    expect(result.status).toBe('conflict')
    expect(result.conflict?.kind).toBe('unowned')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(edited)
    expect(await lockBytes()).toEqual(initialLock)
  })

  it('treats an Orca-looking copy with no lock entry or receipt as someone else’s', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { canonical, input, lockBytes, initialLock } = await fixture({
      'other-skill': { source: 'stablyai/orca' }
    })
    await placeCopy(canonical, OLD_TEXT)

    const [result] = await installBundledOrcaSkills(['test-skill'], input)

    expect(result.status).toBe('conflict')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(OLD_TEXT)
    expect(await lockBytes()).toEqual(initialLock)
  })

  it('adopts an earlier version over its own receipt but not a local edit', async () => {
    packages.value = [entry(OLD_TEXT, [OLD_DIGEST])]
    const { canonical, input } = await fixture(null)
    expect((await installBundledOrcaSkills(['test-skill'], input))[0].status).toBe('installed')

    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    expect((await installBundledOrcaSkills(['test-skill'], input))[0].status).toBe('updated')

    // Something outside Orca put an earlier release back over the receipt.
    await writeFile(join(canonical, 'SKILL.md'), OLD_TEXT)
    expect((await installBundledOrcaSkills(['test-skill'], input))[0].status).toBe('updated')

    await writeFile(join(canonical, 'SKILL.md'), 'mine\n')
    const [edited] = await installBundledOrcaSkills(['test-skill'], input)
    expect(edited.status).toBe('conflict')
    expect(edited.conflict?.kind).toBe('modified')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it('replaces local changes only when asked to discard them', async () => {
    packages.value = [entry(NEW_TEXT, [NEW_DIGEST])]
    const { canonical, input } = await fixture(null)
    await placeCopy(canonical, 'mine\n')

    const [result] = await installBundledOrcaSkills(['test-skill'], {
      ...input,
      discardLocalChanges: true
    })

    expect(result.status).toBe('updated')
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
  })

  it.runIf(process.platform !== 'win32')(
    'keeps the skills CLI link layout in an agent home',
    async () => {
      packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
      const { home, canonical, input } = await fixture({
        'test-skill': { source: 'https://github.com/stablyai/orca.git' }
      })
      await placeCopy(canonical, OLD_TEXT)
      const claudeLink = join(home, '.claude', 'skills', 'test-skill')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await symlink('../../.agents/skills/test-skill', claudeLink)

      const [result] = await installBundledOrcaSkills(['test-skill'], input)

      expect(result.status).toBe('updated')
      expect(await readlink(claudeLink)).toBe('../../.agents/skills/test-skill')
      expect(await readFile(join(claudeLink, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    }
  )

  it('reads the project lock for a workspace install', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { root, input } = await fixture(null)
    const workspace = join(root, 'project')
    const projectCopy = join(workspace, '.agents', 'skills', 'test-skill')
    await placeCopy(projectCopy, OLD_TEXT)
    const projectLock = join(workspace, 'skills-lock.json')
    const lockText = JSON.stringify({
      version: 1,
      skills: { 'test-skill': { source: 'stablyai/orca' } }
    })
    await writeFile(projectLock, lockText)

    const [result] = await installBundledOrcaSkills(['test-skill'], {
      ...input,
      scope: 'workspace',
      workspaceDirectory: workspace,
      detectedProviders: [],
      readLockSources: undefined
    })

    expect(result.status).toBe('updated')
    expect(await readFile(projectLock, 'utf8')).toBe(lockText)
  })

  it('plans without writing', async () => {
    packages.value = [entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])]
    const { canonical, input } = await fixture({ 'test-skill': { source: 'stablyai/orca' } })
    await placeCopy(canonical, OLD_TEXT)

    expect(await planBundledOrcaSkills(['test-skill'], input)).toEqual([
      { name: 'test-skill', canonicalPath: canonical, state: 'unowned', willWrite: true }
    ])
    await writeFile(join(canonical, 'SKILL.md'), 'mine\n')
    expect((await planBundledOrcaSkills(['test-skill'], input))[0].willWrite).toBe(false)
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it('rejects a name this build does not ship', async () => {
    packages.value = [entry(NEW_TEXT, [NEW_DIGEST])]
    const { input } = await fixture(null)
    await expect(installBundledOrcaSkills(['missing'], input)).rejects.toThrow(
      'skill-install-bundled-unknown'
    )
  })
})
