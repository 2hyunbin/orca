import type * as InstructionalIntegrity from './plugin-instructional-content-integrity'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { PluginEnvironmentRecipeRegistry } from './plugin-environment-recipe-registry'
import { PluginContentPackRegistry } from './plugin-content-pack-registry'
import { PluginContentVerifier } from './plugin-content-integrity'
import { hashPluginTree } from './plugin-content-hash'
import { validateDeclaredPluginArtifacts } from './plugin-artifact-validation'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

const hooks = vi.hoisted(() => ({
  beforeVerify: vi.fn(async (_plugin: ValidDiscoveredPlugin) => {})
}))
vi.mock('./plugin-instructional-content-integrity', async (original) => {
  const actual = await original<typeof InstructionalIntegrity>()
  return {
    ...actual,
    verifyInstructionalPluginContent: async (plugin: ValidDiscoveredPlugin) => {
      await hooks.beforeVerify(plugin)
      await actual.verifyInstructionalPluginContent(plugin)
    }
  }
})
const roots: string[] = []
beforeEach(() => {
  hooks.beforeVerify.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function recipe(id = 'pods', name = 'Development pods') {
  const command = {
    program: process.execPath,
    args: ['-e', 'throw new Error("must not execute during registration")']
  }
  return {
    schemaVersion: 1,
    id,
    name,
    description: 'Company development environments',
    lifetime: 'both',
    commands: {
      list: command,
      create: command,
      delete: command,
      sleep: command,
      resume: command,
      archive: command
    }
  }
}
async function plugin(
  publisher = 'company',
  artifacts = [recipe()]
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-environment-registration-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'recipes'))
  const paths = artifacts.map((_value, i) => `recipes/${i}.json`)
  await Promise.all(
    artifacts.map((value, i) => writeFile(join(rootDir, paths[i]!), JSON.stringify(value)))
  )
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'instructional',
    publisher,
    id: 'platform',
    name: 'Company platform',
    version: '1.0.0',
    engines: { orca: '>=1.4.0' },
    pluginApi: 1,
    contributes: { environmentRecipes: paths.map((path) => ({ path })) }
  })
  const content = await hashPluginTree(rootDir)
  if (!content.ok) {
    throw new Error(content.error)
  }
  return {
    pluginKey: `${publisher}.platform`,
    rootDir,
    manifest,
    contentHash: null,
    isDev: true,
    consentContentHash: content.hash,
    consentFingerprint: fingerprintPluginConsent(manifest, content.hash)
  }
}

describe('registered environment recipes use current reviewed bytes', () => {
  it('loads declared CLI metadata without running code; previews remain pending', async () => {
    const p = await plugin()
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => false)
    expect(registry.list()).toEqual([])
    expect(registry.preview(p.pluginKey)).toMatchObject([{ recipe: { id: 'pods' } }])
    expect(await registry.resolve('company.platform/pods')).toBeNull()
    await registry.reconcile([p], () => true)
    expect(await registry.resolve('company.platform/pods')).toMatchObject({
      pluginKey: p.pluginKey,
      recipe: { commands: { create: { program: process.execPath } } }
    })
  })
  it('qualifies identical recipe names by publisher rather than denying unrelated providers', async () => {
    const a = await plugin('company')
    const b = await plugin('community')
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([a, b], () => true)
    expect(registry.list()).toHaveLength(2)
    expect((await registry.resolve('company.platform/pods'))?.pluginKey).toBe(a.pluginKey)
    expect((await registry.resolve('community.platform/pods'))?.pluginKey).toBe(b.pluginKey)
    expect(await registry.resolve('pods')).toBeNull()
  })
  it('does not publish commands when approval is revoked during verification or afterward', async () => {
    const p = await plugin()
    let approved = true
    hooks.beforeVerify.mockImplementation(async () => {
      approved = false
    })
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => approved)
    expect(registry.list()).toEqual([])
    hooks.beforeVerify.mockResolvedValue(undefined)
    approved = true
    await registry.reconcile([p], () => approved)
    expect(registry.list()).toHaveLength(1)
    approved = false
    expect(registry.list()).toEqual([])
    expect(await registry.resolve('company.platform/pods')).toBeNull()
  })
  it('separates admission from the service readiness gate and checks readiness at use', async () => {
    const p = await plugin()
    let ready = false
    const registry = new PluginEnvironmentRecipeRegistry(() => ready)
    await registry.reconcile([p], () => true)
    expect(registry.list()).toEqual([])
    ready = true
    expect(registry.list()).toHaveLength(1)
    ready = false
    expect(await registry.resolve('company.platform/pods')).toBeNull()
  })
  it('rejects recipe bytes changed after approval, including edit then restore during admission', async () => {
    const p = await plugin()
    const artifact = join(p.rootDir, 'recipes/0.json')
    const reviewed = await readFile(artifact, 'utf8')
    await writeFile(artifact, JSON.stringify(recipe('pods', 'Changed before read')))
    hooks.beforeVerify.mockImplementation(async () => {
      await writeFile(artifact, reviewed)
    })
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(p.pluginKey)).toContain('changed since metadata admission')
  })
  it('withdraws a loaded provider when its source changes before execution resolution', async () => {
    const p = await plugin()
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => true)
    await writeFile(
      join(p.rootDir, 'recipes/0.json'),
      JSON.stringify(recipe('pods', 'Changed after load'))
    )
    await expect(registry.resolve('company.platform/pods')).rejects.toThrow('changed since')
    expect(registry.list()).toEqual([])
    expect(registry.error(p.pluginKey)).toContain('changed since')
  })
  it('isolates returned list and preview values from executable registry state', async () => {
    const p = await plugin()
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => true)
    const listing = registry.list()[0]!
    listing.recipe.commands.list.program = 'unreviewed'
    registry.preview(p.pluginKey)[0]!.recipe.commands.list.args.push('unreviewed')
    const current = await registry.resolve('company.platform/pods')
    expect(current?.recipe.commands.list.program).toBe(process.execPath)
    expect(current?.recipe.commands.list.args).not.toContain('unreviewed')
  })
  it('withdraws a held authority before a replacement admission finishes', async () => {
    const old = await plugin()
    const next = await plugin('company', [recipe('pods', 'Replacement')])
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([old], () => true)
    const authority = await registry.resolveAuthority('company.platform/pods')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hooks.beforeVerify.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })
    const staleRead = registry.resolveAuthority('company.platform/pods')
    await entered.promise
    await registry.reconcile([next], () => true)
    expect(authority?.signal.aborted).toBe(true)
    expect(authority?.isCurrent()).toBe(false)
    release.resolve()
    expect(await staleRead).toBeNull()
    expect(registry.list()[0]?.recipe.name).toBe('Replacement')
  })
  it('does not publish metadata when the discovered owner changes during verification', async () => {
    const p = await plugin()
    hooks.beforeVerify.mockImplementation(async () => {
      p.rootDir = '/changed-owner'
    })
    const registry = new PluginEnvironmentRecipeRegistry()
    await registry.reconcile([p], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.preview(p.pluginKey)).toEqual([])
    expect(registry.error(p.pluginKey)).toContain('owner changed during admission')
  })
  it('rejects duplicate IDs and malformed commands before installer publication', async () => {
    const p = await plugin('company', [recipe(), recipe()])
    expect(await validateDeclaredPluginArtifacts(p.rootDir, p.manifest)).toMatchObject({
      ok: false,
      error: expect.stringContaining('duplicate environment recipe')
    })
    const invalid = await plugin('other')
    await writeFile(
      join(invalid.rootDir, 'recipes/0.json'),
      JSON.stringify({ ...recipe(), commands: { list: { shell: 'bad' } } })
    )
    expect(await validateDeclaredPluginArtifacts(invalid.rootDir, invalid.manifest)).toMatchObject({
      ok: false
    })
  })
  it('refuses an artifact symlink that escapes its plugin directory', async () => {
    const p = await plugin()
    const q = await plugin('outside')
    const file = join(p.rootDir, 'recipes/0.json')
    await rm(file)
    try {
      await symlink(join(q.rootDir, 'recipes/0.json'), file)
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return
      }
      throw error
    }
    expect(await validateDeclaredPluginArtifacts(p.rootDir, p.manifest)).toMatchObject({
      ok: false
    })
  })
  it('activates environment recipes through the shared content registry and withdraws a killed provider', async () => {
    const p = await plugin()
    let killed = false
    const registry = new PluginContentPackRegistry(new PluginContentVerifier(), () => killed)
    await registry.reconcile([p], () => true)
    expect(registry.environmentRecipes.list()).toHaveLength(1)
    killed = true
    expect(registry.environmentRecipes.list()).toEqual([])
    expect(await registry.environmentRecipes.resolve('company.platform/pods')).toBeNull()
  })
})
