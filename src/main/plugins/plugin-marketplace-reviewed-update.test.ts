import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { PluginReviewedMarketplaceUpdate } from '../../shared/plugins/plugin-reviewed-update'
import type { Store } from '../persistence'
import { createCatalogReleaseFixture } from './plugin-catalog-release-test-fixture'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { readPluginLockfile } from './plugin-install'
import { installMarketplaceDataPlugin } from './plugin-marketplace-data-action'
import { installReviewedMarketplaceUpdate } from './plugin-marketplace-reviewed-update'
import { PluginService } from './plugin-service'

const pluginKey = 'community.locale-de'
const services: PluginService[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
})

async function writeViewer(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      publisher: 'community',
      id: 'locale-de',
      name: 'German file viewer',
      version: '1.1.0',
      pluginApi: 1,
      engines: { orca: '>=1.0.0' },
      contributes: {
        fileViewers: [
          {
            id: 'sample',
            displayName: 'Sample',
            entry: 'sample.worker.js',
            selector: [{ filenamePattern: '*.sample' }],
            mode: 'readonly',
            rendering: 'host-ui'
          }
        ]
      }
    })
  )
  await writeFile(
    join(directory, 'sample.worker.js'),
    'orcaViewer.register({ open: () => ({kind:"text",lineCount:0}), render: () => ({kind:"text",startLine:0,lines:[]}) });'
  )
}

async function setup() {
  const fixture = await createCatalogReleaseFixture()
  let settings = getDefaultSettings(fixture.root)
  let failNextWrite = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This action uses only these Store methods, backed by a complete settings object.
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('settings publication failed')
      }
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
  expect(
    await installMarketplaceDataPlugin({
      store,
      pluginService,
      marketplace: fixture.marketplace,
      installer: fixture.installer,
      marketplaceSourceId: fixture.source.id,
      marketplaceCommit: 'f'.repeat(40),
      pluginKey
    })
  ).toEqual({ kind: 'installed', pluginKey })
  const previous = pluginService.findValidPlugin(pluginKey)!
  await fixture.publishPack(writeViewer)
  const preview = await fixture.installer.preview(fixture.source.id, pluginKey)
  if (!preview.reviewRevision || !previous.contentHash) {
    throw new Error('missing release receipt')
  }
  const request: PluginReviewedMarketplaceUpdate = {
    marketplaceSourceId: preview.marketplaceSourceId,
    marketplaceCommit: preview.marketplaceCommit,
    pluginKey,
    resolvedCommit: preview.resolvedCommit,
    contentHash: preview.contentHash,
    reviewedFingerprint: preview.consentFingerprint,
    reviewedRevision: preview.reviewRevision,
    currentContentHash: previous.contentHash
  }
  const approve = (receipt = request) =>
    installReviewedMarketplaceUpdate({
      request: receipt,
      store,
      pluginService,
      installer: fixture.installer
    })
  const pointer = () => readPluginCurrentPointer(join(fixture.root, 'plugins', pluginKey))
  return {
    ...fixture,
    store,
    pluginService,
    previous,
    preview,
    request,
    approve,
    pointer,
    failSettingsPublication: () => {
      failNextWrite = true
    }
  }
}

it('keeps an approved data release active during executable review, then promotes exact reviewed bytes', async () => {
  const harness = await setup()
  expect(await harness.pointer()).toBe(harness.previous.contentHash)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
  expect(harness.pluginService.contentPacks.fileViewers.list()).toHaveLength(0)
  expect(await harness.approve()).toMatchObject({
    ok: true,
    contentHash: harness.preview.contentHash
  })
  expect(await harness.pointer()).toBe(harness.preview.contentHash)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(0)
  expect(harness.pluginService.contentPacks.fileViewers.list()).toHaveLength(1)
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(
    harness.preview.consentFingerprint
  )
})

it.each(['reviewedFingerprint', 'reviewedRevision', 'resolvedCommit', 'contentHash'] as const)(
  'rejects a stale %s receipt while retaining the approved release',
  async (field) => {
    const harness = await setup()
    const request = {
      ...harness.request,
      [field]: 'c'.repeat(field === 'resolvedCommit' ? 40 : 64)
    }
    expect(await harness.approve(request)).toMatchObject({ ok: false })
    expect(await harness.pointer()).toBe(harness.previous.contentHash)
    expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
    expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(
      harness.previous.consentFingerprint
    )
  }
)

it('restores pointer, source index and consent if approval persistence fails after mutation', async () => {
  const harness = await setup()
  const oldLock = await readPluginLockfile(join(harness.root, 'plugins'))
  harness.failSettingsPublication()
  expect(await harness.approve()).toMatchObject({ ok: false, error: 'settings publication failed' })
  expect(await harness.pointer()).toBe(harness.previous.contentHash)
  expect(await readPluginLockfile(join(harness.root, 'plugins'))).toEqual(oldLock)
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(
    harness.previous.consentFingerprint
  )
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
  expect(harness.pluginService.contentPacks.fileViewers.list()).toHaveLength(0)
})

it('preserves a disabled choice when the user approves the replacement release', async () => {
  const harness = await setup()
  harness.store.updateSettings({ disabledPlugins: [pluginKey] })
  await harness.pluginService.reconcileActivationState()
  expect(await harness.approve()).toMatchObject({ ok: true })
  expect(harness.store.getSettings().disabledPlugins).toContain(pluginKey)
  expect(harness.pluginService.contentPacks.fileViewers.list()).toHaveLength(0)
})

it('prevents the ordinary catalog installer from bypassing update review', async () => {
  const harness = await setup()
  expect(await harness.installer.install(harness.preview)).toMatchObject({
    ok: false,
    error: expect.stringContaining('review this update')
  })
  expect(await harness.pointer()).toBe(harness.previous.contentHash)
  expect(harness.pluginService.contentPacks.languagePacks.list()).toHaveLength(1)
})

it('preserves a consent revocation made while the replacement is being fetched', async () => {
  const harness = await setup()
  const preview = harness.installer.preview.bind(harness.installer)
  vi.spyOn(harness.installer, 'preview').mockImplementationOnce(async (...args) => {
    const consents = { ...harness.store.getSettings().pluginConsents }
    delete consents[pluginKey]
    harness.store.updateSettings({ pluginConsents: consents })
    return preview(...args)
  })
  expect(await harness.approve()).toMatchObject({
    ok: false,
    error: expect.stringContaining('approval changed')
  })
  expect(await harness.pointer()).toBe(harness.previous.contentHash)
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBeUndefined()
  expect(harness.pluginService.contentPacks.fileViewers.list()).toHaveLength(0)
})

it('does not let a mutable caller change its receipt while Git preview is awaiting', async () => {
  const harness = await setup()
  const preview = harness.installer.preview.bind(harness.installer)
  const receipt = { ...harness.request }
  vi.spyOn(harness.installer, 'preview').mockImplementationOnce(async (...args) => {
    receipt.reviewedFingerprint = 'unreviewed'
    receipt.contentHash = 'c'.repeat(64)
    return preview(...args)
  })
  expect(await harness.approve(receipt)).toMatchObject({
    ok: true,
    contentHash: harness.preview.contentHash
  })
  expect(harness.store.getSettings().pluginConsents[pluginKey]).toBe(
    harness.preview.consentFingerprint
  )
})

async function providerUpdate() {
  const f = await setup()
  await f.publishPack(async (directory) => {
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'instructional',
        publisher: 'community',
        id: 'locale-de',
        name: 'Company machines',
        version: '1.2.0',
        pluginApi: 1,
        engines: { orca: '>=1.0.0' },
        contributes: { environmentRecipes: [{ path: 'pods.json' }] }
      })
    )
    await writeFile(
      join(directory, 'pods.json'),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        id: 'pods',
        name: 'Development pods',
        description: 'Company machines',
        lifetime: 'both',
        commands: Object.fromEntries(
          ['create', 'list', 'delete', 'sleep', 'resume', 'archive'].map((action) => [
            action,
            { program: 'company-cli', args: [action], timeoutSeconds: 30 }
          ])
        )
      })
    )
  })
  const preview = await f.installer.preview(f.source.id, pluginKey)
  const request = {
    ...f.request,
    contentHash: preview.contentHash,
    reviewedFingerprint: preview.consentFingerprint,
    reviewedRevision: preview.reviewRevision ?? '',
    reviewedEnvironmentRecipeDigest: preview.environmentRecipeReviewDigest
  }
  return { ...f, providerPreview: preview, providerRequest: request }
}
it('requires explicit source-bound provider command review before promoting an executable update', async () => {
  const f = await providerUpdate()
  const { reviewedEnvironmentRecipeDigest: _digest, ...oldClientRequest } = f.providerRequest
  expect(await f.approve(oldClientRequest)).toMatchObject({
    ok: false,
    error: expect.stringContaining('full instruction review')
  })
  expect(await f.pointer()).toBe(f.previous.contentHash)
  expect(
    await f.approve({ ...f.providerRequest, reviewedEnvironmentRecipeDigest: 'a'.repeat(64) })
  ).toMatchObject({ ok: false })
  expect(await f.pointer()).toBe(f.previous.contentHash)
  expect(await f.approve(f.providerRequest)).toMatchObject({
    ok: true,
    contentHash: f.providerPreview.contentHash
  })
  expect(await f.pointer()).toBe(f.providerPreview.contentHash)
  expect(f.pluginService.contentPacks.environmentRecipes.list()).toHaveLength(1)
})
