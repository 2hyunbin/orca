import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as pluginContentHash from './plugin-content-hash'
import {
  discoverPlugins,
  isInvalidDiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { installPluginFromLocalPath } from './plugin-install'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'
import { getDefaultSettings } from '../../shared/constants'
import type { Store } from '../persistence'
import { PluginService } from './plugin-service'
import { applyPluginConsent } from './plugin-enablement'

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'example.syntax'
const manifest = {
  manifestVersion: 2,
  execution: 'data',
  publisher: 'example',
  id: 'syntax',
  name: 'Syntax',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {}
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reviewed-release-')))
  roots.push(root)
  const sourcePath = join(root, 'source')
  const pluginsDir = join(root, 'plugins')
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'orca-plugin.json'), JSON.stringify(manifest))
  return { root, sourcePath, pluginsDir }
}
async function discover(
  pluginsDir: string,
  devPluginPaths: string[] = []
): Promise<ValidDiscoveredPlugin> {
  const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths, hostVersion: '1.4.0' })
  if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
    throw new Error('expected valid package')
  }
  return plugin
}

it('binds installed approval to source ownership while keeping ordinary data updates approved', async () => {
  const { root, sourcePath, pluginsDir } = await setup()
  const firstInstall = await installPluginFromLocalPath({
    pluginsDir,
    sourcePath,
    hostVersion: '1.4.0'
  })
  const first = await discover(pluginsDir)
  expect(firstInstall).toMatchObject({ ok: true, consentFingerprint: first.consentFingerprint })
  await verifyReviewedPluginRelease(first, first.reviewRevision)
  await writeFile(
    join(sourcePath, 'orca-plugin.json'),
    JSON.stringify({ ...manifest, version: '1.1.0' })
  )
  await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
  const next = await discover(pluginsDir)
  expect(next.consentFingerprint).toBe(first.consentFingerprint)
  expect(next.reviewRevision).not.toBe(first.reviewRevision)
  await expect(verifyReviewedPluginRelease(first, first.reviewRevision)).rejects.toThrow('changed')
  await expect(verifyReviewedPluginRelease(next, first.reviewRevision)).rejects.toThrow('changed')
  const movedSource = join(root, 'another-owner')
  await mkdir(movedSource)
  await writeFile(
    join(movedSource, 'orca-plugin.json'),
    JSON.stringify({ ...manifest, version: '1.2.0' })
  )
  await installPluginFromLocalPath({ pluginsDir, sourcePath: movedSource, hostVersion: '1.4.0' })
  const moved = await discover(pluginsDir)
  expect(moved.consentFingerprint).not.toBe(next.consentFingerprint)
  await verifyReviewedPluginRelease(moved, moved.reviewRevision)
})

it('refuses approval when a same-permission installed release moves before service refresh', async () => {
  const { root, sourcePath, pluginsDir } = await setup()
  await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
  let settings = getDefaultSettings(root)
  const writes: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Consent uses only these Store methods; settings retain the complete default shape.
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<typeof settings>) => {
      writes.push(updates)
      settings = { ...settings, ...updates }
    }
  } as Store
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => settings.disabledPlugins,
    getPluginConsents: () => settings.pluginConsents,
    getDevPluginPaths: () => []
  })
  services.push(service)
  await service.initialize()
  const reviewed = service.findValidPlugin(pluginKey)!
  await expect(
    applyPluginConsent({
      store,
      pluginService: service,
      pluginKey,
      reviewedFingerprint: reviewed.consentFingerprint,
      decision: 'approve'
    })
  ).rejects.toThrow('changed')
  expect(writes).toHaveLength(0)
  await writeFile(
    join(sourcePath, 'orca-plugin.json'),
    JSON.stringify({ ...manifest, version: '1.1.0' })
  )
  await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
  await expect(
    applyPluginConsent({
      store,
      pluginService: service,
      pluginKey,
      reviewedFingerprint: reviewed.consentFingerprint,
      reviewedRevision: reviewed.reviewRevision,
      decision: 'approve'
    })
  ).rejects.toThrow('changed')
  expect(writes).toHaveLength(0)
  await service.refresh()
  const current = service.findValidPlugin(pluginKey)!
  await applyPluginConsent({
    store,
    pluginService: service,
    pluginKey,
    reviewedFingerprint: current.consentFingerprint,
    reviewedRevision: current.reviewRevision,
    decision: 'approve'
  })
  expect(service.activationState(current)).toBe('approved')
})

it('rejects changed development bytes and source paths even without a manifest refresh', async () => {
  const { sourcePath, pluginsDir } = await setup()
  const plugin = await discover(pluginsDir, [sourcePath])
  await verifyReviewedPluginRelease(plugin, plugin.reviewRevision)
  await writeFile(join(sourcePath, 'sample.json'), '{"replacement":true}')
  await expect(verifyReviewedPluginRelease(plugin, plugin.reviewRevision)).rejects.toThrow(
    'content changed'
  )
  const next = await discover(pluginsDir, [sourcePath])
  expect(next.consentFingerprint).toBe(plugin.consentFingerprint)
  expect(next.reviewRevision).not.toBe(plugin.reviewRevision)
})

it('rejects development bytes changed between content and source verification', async () => {
  const { sourcePath, pluginsDir } = await setup()
  const plugin = await discover(pluginsDir, [sourcePath])
  const hash = pluginContentHash.hashPluginTree
  vi.spyOn(pluginContentHash, 'hashPluginTree').mockImplementationOnce(async (root) => {
    const result = await hash(root)
    await writeFile(join(sourcePath, 'replacement.json'), '{"changed":true}')
    return result
  })
  await expect(verifyReviewedPluginRelease(plugin, plugin.reviewRevision)).rejects.toThrow(
    'release changed'
  )
})
