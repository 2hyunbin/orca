import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginBundledDataRegistry } from './plugin-bundled-data-registry'
import { PluginService } from './plugin-service'
import { hashPluginTree } from './plugin-content-hash'
import { isInvalidDiscoveredPlugin } from './plugin-discovery'
import { installStagedPluginTree } from './plugin-install-staging'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { bootstrapBundledPlugins } from './plugin-bundled-bootstrap'
import { applyBundledDataEnablement } from './plugin-bundled-data-enablement'
import { getDefaultSettings } from '../../shared/constants'
import {
  projectLegacyPluginSyntaxMetadata,
  projectLegacyPluginSyntaxPayload
} from './plugin-syntax-client-projection'

const packagedRoot = join(process.cwd(), 'resources', 'plugins', 'launch')
const syntaxKey = 'stablyai.orca-syntax-typst'
const localeKey = 'stablyai.orca-locale-es'
const roots: string[] = []
const services: PluginService[] = []
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-bundled-data-'))
  roots.push(root)
  return root
}
async function fixture(): Promise<string> {
  const root = await scratch()
  await cp(join(packagedRoot, syntaxKey), join(root, syntaxKey), { recursive: true })
  const tree = await hashPluginTree(join(root, syntaxKey))
  if (!tree.ok) {
    throw new Error(tree.error)
  }
  await writeFile(
    join(root, 'bundled-plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          pluginKey: syntaxKey,
          path: syntaxKey,
          contentHash: tree.hash,
          activation: 'bundled-data'
        }
      ]
    })
  )
  return root
}
async function rewriteIndex(root: string): Promise<void> {
  const tree = await hashPluginTree(join(root, syntaxKey))
  if (!tree.ok) {
    throw new Error(tree.error)
  }
  await writeFile(
    join(root, 'bundled-plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          pluginKey: syntaxKey,
          path: syntaxKey,
          contentHash: tree.hash,
          activation: 'bundled-data'
        }
      ]
    })
  )
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('app-owned v2 data availability', () => {
  it('loads actual shipped locale and grammar offline without optional enablement or consent', async () => {
    const userDataPath = await scratch()
    const workers = vi.fn()
    const service = new PluginService({
      userDataPath,
      bundledPluginsRoot: packagedRoot,
      hostVersion: '1.4.214',
      isPluginSystemEnabled: () => false,
      getDisabledPlugins: () => [localeKey, syntaxKey],
      getPluginConsents: () => ({}),
      getDevPluginPaths: () => [],
      workerFactory: workers
    })
    services.push(service)
    await service.initialize()
    const packs = service.contentPacks.languagePacks.list()
    expect(packs).toHaveLength(1)
    expect(packs[0]).toMatchObject({
      pluginKey: localeKey,
      locale: 'es',
      displayName: 'Español',
      builtInLocale: 'es'
    })
    expect(packs[0]?.coverage?.current).toBeGreaterThan(15_000)
    expect(packs[0]?.catalog).toMatchObject({ menu: { file: 'Archivo' } })
    const syntaxes = service.contentPacks.syntaxPacks.list()
    expect(syntaxes).toHaveLength(1)
    expect(syntaxes[0]?.languages[0]).toMatchObject({ id: 'typst', extensions: ['.typ'] })
    const loaded = await service.contentPacks.syntaxPacks.load(syntaxKey, syntaxes[0]!.revision)
    expect(loaded?.grammars[0]?.content).toContain('source.typst')
    expect(syntaxes[0]?.languages[0]?.builtInLanguage).toBe('typst')
    expect(projectLegacyPluginSyntaxMetadata(syntaxes[0]!).languages[0]).not.toHaveProperty(
      'builtInLanguage'
    )
    if (!loaded) {
      throw new Error('Expected syntax content')
    }
    const legacy = projectLegacyPluginSyntaxPayload(loaded)
    expect(legacy.languages[0]).not.toHaveProperty('builtInLanguage')
    expect(legacy.languages[0]?.configuration).toEqual(loaded.languages[0]?.configuration)
    expect(legacy.grammars).toEqual(loaded.grammars)
    expect(workers).not.toHaveBeenCalled()
    expect(
      service
        .getDiscovered()
        .every(
          (plugin) =>
            !isInvalidDiscoveredPlugin(plugin) && service.activationState(plugin) === 'approved'
        )
    ).toBe(true)
    await expect(access(join(userDataPath, 'plugins'))).rejects.toThrow()
  })

  it('persists separate disable/restore choices without changing consent or the optional switch', async () => {
    const userDataPath = await scratch()
    let settings = { ...getDefaultSettings(userDataPath), pluginSystemEnabled: false }
    const store = {
      getSettings: () => settings,
      updateSettings: (updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      }
    }
    const service = new PluginService({
      userDataPath,
      bundledPluginsRoot: packagedRoot,
      hostVersion: '1.4.214',
      isPluginSystemEnabled: () => settings.pluginSystemEnabled,
      getDisabledPlugins: () => settings.disabledPlugins,
      getDisabledBundledDataPlugins: () => settings.disabledBundledDataPlugins ?? [],
      getPluginConsents: () => settings.pluginConsents,
      getDevPluginPaths: () => []
    })
    services.push(service)
    await service.initialize()
    await applyBundledDataEnablement({
      store,
      pluginService: service,
      pluginKey: localeKey,
      enabled: false
    })
    expect(service.contentPacks.languagePacks.list()).toEqual([])
    expect(service.contentPacks.syntaxPacks.list()).toHaveLength(1)
    expect(service.listBundledData().find((pack) => pack.pluginKey === localeKey)).toMatchObject({
      enabled: false,
      unavailable: false
    })
    expect(settings.pluginSystemEnabled).toBe(false)
    expect(settings.pluginConsents).toEqual({})
    expect(settings.disabledPlugins).toEqual([])
    await service.refresh()
    expect(service.contentPacks.languagePacks.list()).toEqual([])
    await applyBundledDataEnablement({
      store,
      pluginService: service,
      pluginKey: localeKey,
      enabled: true
    })
    expect(service.contentPacks.languagePacks.list()[0]?.builtInLocale).toBe('es')
    await expect(
      applyBundledDataEnablement({
        store,
        pluginService: service,
        pluginKey: 'community.language',
        enabled: true
      })
    ).rejects.toThrow('Unknown')
  })

  it('keeps an approved optional pin, restores the bundled snapshot on feature-off/disable, and revokes both', async () => {
    const userDataPath = await scratch()
    const source = await scratch()
    await cp(join(packagedRoot, syntaxKey), source, { recursive: true })
    const manifest = JSON.parse(await readFile(join(source, 'orca-plugin.json'), 'utf8'))
    manifest.version = '0.9.0'
    await writeFile(join(source, 'orca-plugin.json'), JSON.stringify(manifest))
    const installed = await installStagedPluginTree({
      pluginsDir: join(userDataPath, 'plugins'),
      stagingDir: source,
      hostVersion: '1.4.214',
      source: {
        kind: 'git',
        url: 'https://github.com/stablyai/orca-plugin-syntax-typst.git',
        ref: 'v0.9.0'
      },
      resolvedCommit: 'a'.repeat(40)
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    let enabled = true
    let disabled: string[] = []
    let killed = false
    const service = new PluginService({
      userDataPath,
      bundledPluginsRoot: packagedRoot,
      hostVersion: '1.4.214',
      isPluginSystemEnabled: () => enabled,
      getDisabledPlugins: () => disabled,
      getPluginConsents: () => ({ [syntaxKey]: installed.consentFingerprint }),
      getDevPluginPaths: () => [],
      getPluginKillListEntry: (key) =>
        killed && key === syntaxKey ? { pluginKey: key, reason: 'fixture revocation' } : null
    })
    services.push(service)
    await service.initialize()
    expect(service.contentPacks.syntaxPacks.list()[0]?.revision).toBe(installed.contentHash)
    expect(service.listBundledData().find((pack) => pack.pluginKey === syntaxKey)).toMatchObject({
      source: 'installed',
      version: '0.9.0',
      bundledVersion: '1.0.0'
    })
    enabled = false
    await service.refresh()
    const bundledHash = service.contentPacks.syntaxPacks.list()[0]!.revision
    expect(bundledHash).not.toBe(installed.contentHash)
    expect(service.listBundledData().find((pack) => pack.pluginKey === syntaxKey)).toMatchObject({
      source: 'bundled',
      version: '1.0.0'
    })
    enabled = true
    disabled = [syntaxKey]
    await service.refresh()
    expect(service.contentPacks.syntaxPacks.list()[0]?.revision).toBe(bundledHash)
    expect(await readPluginCurrentPointer(join(userDataPath, 'plugins', syntaxKey))).toBe(
      installed.contentHash
    )
    disabled = []
    await service.reconcileActivationState()
    expect(service.contentPacks.syntaxPacks.list()[0]?.revision).toBe(installed.contentHash)
    killed = true
    expect(await service.contentPacks.syntaxPacks.load(syntaxKey, installed.contentHash)).toBeNull()
    await service.reconcileActivationState()
    expect(service.contentPacks.syntaxPacks.list()).toEqual([])
    expect(service.contentPacks.languagePacks.list()).toHaveLength(1)
    enabled = false
    await service.refresh()
    expect(service.contentPacks.syntaxPacks.list()).toEqual([])
  })

  it('refuses executable packages even with a matching app index and never imports their entry', async () => {
    const root = await fixture()
    const marker = join(root, 'unapproved-execution')
    const manifest = JSON.parse(await readFile(join(root, syntaxKey, 'orca-plugin.json'), 'utf8'))
    manifest.execution = 'trusted-worker'
    manifest.main = 'worker.js'
    await writeFile(join(root, syntaxKey, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(
      join(root, syntaxKey, 'worker.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
    )
    await rewriteIndex(root)
    const registry = new PluginBundledDataRegistry({ root, hostVersion: '1.4.214' })
    await registry.refresh()
    expect(registry.discovery([])).toEqual([
      expect.objectContaining({ error: expect.stringContaining('data-only') })
    ])
    await expect(access(marker)).rejects.toThrow()
    expect(registry.content([], false, { disabledPlugins: [], pluginConsents: {} })).toEqual([])
  })

  it('rejects app metadata tampering and withdraws stale snapshot identities', async () => {
    const root = await fixture()
    const registry = new PluginBundledDataRegistry({ root, hostVersion: '1.4.214' })
    await registry.refresh()
    const previous = registry.discovery([])[0]!
    if (isInvalidDiscoveredPlugin(previous)) {
      throw new Error(previous.error)
    }
    expect(registry.owns(previous)).toBe(true)
    await writeFile(join(root, syntaxKey, 'README.md'), 'tampered bytes')
    await registry.refresh()
    expect(registry.owns(previous)).toBe(false)
    expect(registry.discovery([])).toEqual([
      expect.objectContaining({ error: expect.stringContaining('release index') })
    ])
  })

  it('never gives a shadowing development package the app-owned alias or automatic authority', async () => {
    const root = await fixture()
    const registry = new PluginBundledDataRegistry({ root, hostVersion: '1.4.214' })
    await registry.refresh()
    const snapshot = registry.discovery([])[0]!
    if (isInvalidDiscoveredPlugin(snapshot)) {
      throw new Error(snapshot.error)
    }
    const impostor = { ...snapshot, isDev: true }
    expect(registry.owns(impostor)).toBe(false)
    expect(registry.syntaxAlias(impostor, 'typst')).toBeUndefined()
    expect(
      registry.content([impostor], true, {
        pluginConsents: { [syntaxKey]: impostor.consentFingerprint },
        disabledPlugins: []
      })
    ).toEqual([snapshot])
  })

  it('never publishes app-owned data over an optional installation', async () => {
    const root = await fixture()
    const userDataPath = await scratch()
    await mkdir(join(userDataPath, 'plugins', syntaxKey), { recursive: true })
    await writeFile(join(userDataPath, 'plugins', syntaxKey, 'current'), 'b'.repeat(64))
    expect(await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.214' })).toEqual({
      installed: [],
      unchanged: [],
      errors: []
    })
    expect(await readPluginCurrentPointer(join(userDataPath, 'plugins', syntaxKey))).toBe(
      'b'.repeat(64)
    )
  })
})
