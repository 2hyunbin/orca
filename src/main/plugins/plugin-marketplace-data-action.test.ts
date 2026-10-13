import { createCatalogReleaseFixture } from './plugin-catalog-release-test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { Store } from '../persistence'
import { PluginService } from './plugin-service'
import { installMarketplaceDataPlugin } from './plugin-marketplace-data-action'
import { readPluginCurrentPointer } from './plugin-current-pointer'

const pluginKey = 'community.locale-de'
const services: PluginService[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})
async function setup() {
  const fixture = await createCatalogReleaseFixture()
  let settings = getDefaultSettings(fixture.root)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The action only reads and updates these Store methods using a complete default settings object.
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
    }
  } as Store
  const pluginService = new PluginService({
    userDataPath: fixture.root,
    hostVersion: '1.0.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => settings.disabledPlugins,
    getPluginConsents: () => settings.pluginConsents,
    getDevPluginPaths: () => []
  })
  services.push(pluginService)
  await pluginService.initialize()
  const action = () =>
    installMarketplaceDataPlugin({
      store,
      pluginService,
      marketplace: fixture.marketplace,
      installer: fixture.installer,
      pluginKey,
      marketplaceSourceId: fixture.source.id,
      marketplaceCommit: 'f'.repeat(40)
    })
  return { ...fixture, pluginService, store, action }
}

it('installs and enables only a checked v2 data release from an explicit action', async () => {
  const harness = await setup()
  expect(await harness.action()).toEqual({ kind: 'installed', pluginKey })
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
  const installed = harness.pluginService.findValidPlugin(pluginKey)!
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(installed.consentFingerprint)
  expect(installed.consentSource).toMatchObject({
    kind: 'marketplace',
    marketplace: { owner: 'community' }
  })
  harness.store.updateSettings({ disabledPlugins: [pluginKey] })
  await harness.pluginService.reconcileActivationState()
  expect(await harness.action()).toEqual({ kind: 'installed', pluginKey })
  expect(harness.store.getSettings().disabledPlugins).toContain(pluginKey)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(0)
})

it('keeps the installed release and approval when catalog ownership needs review', async () => {
  const harness = await setup()
  await harness.action()
  const old = harness.pluginService.findValidPlugin(pluginKey)!
  harness.setOwner('new-owner')
  await harness.marketplace.refreshSource(harness.source.id)
  const result = await harness.action()
  expect(result.kind).toBe('review')
  if (result.kind !== 'review') {
    throw new Error('expected source review')
  }
  expect(result.preview.consentFingerprint).not.toBe(old.consentFingerprint)
  expect(harness.pluginService.findValidPlugin(pluginKey)).toBe(old)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
  expect(await readPluginCurrentPointer(join(harness.root, 'plugins', pluginKey))).toBe(
    old.contentHash
  )
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(old.consentFingerprint)
})

it('rejects a stale catalog action before installing or granting approval', async () => {
  const harness = await setup()
  expect(
    await installMarketplaceDataPlugin({
      store: harness.store,
      pluginService: harness.pluginService,
      marketplace: harness.marketplace,
      installer: harness.installer,
      pluginKey,
      marketplaceSourceId: harness.source.id,
      marketplaceCommit: 'e'.repeat(40)
    })
  ).toMatchObject({ kind: 'error' })
  expect(harness.pluginService.findValidPlugin(pluginKey)).toBeNull()
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBeUndefined()
})

it('checks data authority and the previous pointer inside the serialized installer', async () => {
  const harness = await setup()
  const preview = await harness.installer.preview(harness.source.id, pluginKey)
  expect(
    await harness.installer.install(preview, {
      consentFingerprint: 'unreviewed-source',
      currentContentHash: null
    })
  ).toMatchObject({ ok: false, error: expect.stringContaining('authority changed') })
  expect(await readPluginCurrentPointer(join(harness.root, 'plugins', pluginKey))).toBeNull()
  expect(
    await harness.installer.install(preview, {
      consentFingerprint: preview.consentFingerprint,
      currentContentHash: 'b'.repeat(64)
    })
  ).toMatchObject({ ok: false, error: expect.stringContaining('installed plugin changed') })
  expect(await readPluginCurrentPointer(join(harness.root, 'plugins', pluginKey))).toBeNull()
})

it('routes newly executable previews to review without publishing or stopping the previous data pack', async () => {
  const harness = await setup()
  await harness.action()
  const previous = harness.pluginService.findValidPlugin(pluginKey)!
  const preview = await harness.installer.preview(harness.source.id, pluginKey)
  const manifest = pluginManifestSchema.parse({
    ...preview.manifest,
    version: '1.1.0',
    execution: 'trusted-worker',
    main: 'worker.js'
  })
  const candidate = {
    ...preview,
    manifest,
    consentFingerprint: fingerprintPluginConsent(
      manifest,
      preview.contentHash,
      previous.consentSource
    )
  }
  vi.spyOn(harness.installer, 'preview').mockResolvedValueOnce(candidate)
  const publish = vi.spyOn(harness.installer, 'install')
  expect(await harness.action()).toEqual({ kind: 'review', preview: candidate })
  expect(publish).not.toHaveBeenCalled()
  expect(harness.pluginService.findValidPlugin(pluginKey)).toBe(previous)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(previous.consentFingerprint)
})
