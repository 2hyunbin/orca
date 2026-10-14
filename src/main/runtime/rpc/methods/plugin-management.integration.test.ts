import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../../../persistence'
import { OrcaRuntimeService } from '../../orca-runtime'
import { pairedRuntimeRpcFixture } from '../../runtime-paired-rpc-test-fixture'
import { setPluginServiceForRpc } from './plugins'
import { applyPluginConsent, applyPluginEnablement } from '../../../plugins/plugin-enablement'
import { PluginManagementController } from '../../../plugins/plugin-management-controller'
import { PluginMarketplaceService } from '../../../plugins/plugin-marketplace-service'
import { PluginMarketplaceInstaller } from '../../../plugins/plugin-marketplace-installer'
import { getPluginsDataDir } from '../../../plugins/plugin-discovery'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from '../../../plugins/plugin-environment-provider-install-fixture'
import { PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY } from '../../../../shared/plugins/plugin-management-api'
import { unwrapRuntimeRpcResult } from '../../../../shared/runtime-rpc-result'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/paired-runtime-connection'
import { PluginEnvironmentProviderRuntimeClient } from '../../../../shared/plugins/plugin-environment-provider-runtime-client'
import * as release from '../../../plugins/plugin-reviewed-release'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  setPluginServiceForRpc(null)
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await disposePluginEnvironmentProviderInstallFixtures()
})
async function fixture() {
  const f = await createPluginEnvironmentProviderInstallFixture({ portable: true })
  const store = new Store({
    dataFile: join(f.root, 'profile.json'),
    serializedState: JSON.stringify({ settings: { pluginSystemEnabled: true } })
  })
  cleanups.push(() => store.freezeWritesAsync())
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir: getPluginsDataDir(f.service.options.userDataPath),
    fetcher: async () => {
      throw new Error('Offline fixture')
    }
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace,
    userDataPath: f.service.options.userDataPath,
    hostVersion: '1.4.0'
  })
  const controller = new PluginManagementController(f.service, store, { marketplace, installer })
  cleanups.push(() => controller.dispose())
  setPluginServiceForRpc(f.service, {
    management: controller,
    applyConsent: (request) => applyPluginConsent({ store, pluginService: f.service, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService: f.service, pluginKey, enabled })
  })
  const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(store), f.root)
  const connection = host.connect([PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY])
  const call = (method: string, input: unknown = {}, runtimeId = host.runtime.getRuntimeId()) =>
    connection.request('plugins.management.call', { runtimeId, method, input }, 5000)
  return { ...f, store, marketplace, controller, host, connection, call }
}
it('advertises only composed management, uses the selected profile, and refuses injection', async () => {
  const f = await fixture()
  expect(
    unwrapRuntimeRpcResult(await f.connection.request('status.get', undefined, 5000))
  ).toMatchObject({ capabilities: expect.arrayContaining([PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY]) })
  expect(unwrapRuntimeRpcResult(await f.call('state'))).toMatchObject({ pluginSystemEnabled: true })
  expect(unwrapRuntimeRpcResult(await f.call('list'))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pluginKey: 'company.platform', status: 'pending' })
    ])
  )
  for (const [method, input] of [
    ['updateSettings', { pluginConsents: { 'company.platform': 'forged' } }],
    ['updateSettings', { sshTargets: [] }],
    ['install', { kind: 'local-path', path: '/elsewhere', command: 'touch injected' }],
    ['invokeCommand', { command: 'anything' }],
    ['list', { executionHostId: 'foreign' }]
  ]) {
    expect(await f.call(String(method), input)).toMatchObject({ ok: false })
  }
  expect(await f.call('state', {}, 'previous-instance')).toMatchObject({ ok: false })
  const old = f.host.connect([])
  expect(
    await old.request(
      'plugins.management.call',
      {
        runtimeId: f.host.runtime.getRuntimeId(),
        method: 'state',
        input: {}
      },
      5000
    )
  ).toMatchObject({ ok: false })
  const mobile = await pairedRuntimeRpcFixture(cleanups, f.host.runtime, f.root, 'mobile')
  expect(
    await mobile.connect([PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY]).request(
      'plugins.management.call',
      {
        runtimeId: f.host.runtime.getRuntimeId(),
        method: 'state',
        input: {}
      },
      5000
    )
  ).toMatchObject({ ok: false })
  await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  expect(f.store.getSettings().pluginConsents).toEqual({})
  setPluginServiceForRpc(null)
  expect(
    unwrapRuntimeRpcResult(await f.connection.request('status.get', undefined, 5000))
  ).toMatchObject({
    capabilities: expect.not.arrayContaining([PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY])
  })
})
it('records only an exact host release approval and does not execute its provider', async () => {
  const f = await fixture()
  const plugin = f.service.findValidPlugin('company.platform')
  if (!plugin?.reviewRevision) {
    throw new Error('Missing provider review')
  }
  const input = {
    pluginKey: plugin.pluginKey,
    reviewedFingerprint: plugin.consentFingerprint,
    reviewedRevision: plugin.reviewRevision,
    decision: 'approve'
  }
  expect(await f.call('consent', { ...input, reviewedRevision: '0'.repeat(64) })).toMatchObject({
    ok: false
  })
  expect(await f.call('consent', input)).toMatchObject({ ok: true })
  expect(f.store.getSettings().pluginConsents).toEqual({
    'company.platform': plugin.consentFingerprint
  })
  await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
})
it('drains a disconnected approval without committing it after asynchronous release validation', async () => {
  const f = await fixture()
  const plugin = f.service.findValidPlugin('company.platform')
  if (!plugin?.reviewRevision) {
    throw new Error('Missing provider review')
  }
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const original = release.verifyReviewedPluginRelease
  vi.spyOn(release, 'verifyReviewedPluginRelease').mockImplementation(async (...args) => {
    entered.resolve()
    await finish.promise
    await original(...args)
  })
  const owner = new AbortController()
  const approval = f.controller.call(
    {
      runtimeId: f.host.runtime.getRuntimeId(),
      method: 'consent',
      input: {
        pluginKey: plugin.pluginKey,
        reviewedFingerprint: plugin.consentFingerprint,
        reviewedRevision: plugin.reviewRevision,
        decision: 'approve'
      }
    },
    owner.signal
  )
  const refused = expect(approval).rejects.toThrow()
  await entered.promise
  owner.abort()
  let drained = false
  const disposing = f.controller.dispose().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish.resolve()
  await refused
  await disposing
  expect(drained).toBe(true)
  expect(f.store.getSettings().pluginConsents).toEqual({})
  await expect(
    f.controller.call({ runtimeId: 'x', method: 'state', input: {} }, new AbortController().signal)
  ).rejects.toThrow()
})
it('seeds the official source on the host and drains its pending metadata write', async () => {
  const f = await fixture()
  const finish = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const seedSource = f.marketplace.seedOfficialSource.bind(f.marketplace)
  vi.spyOn(f.marketplace, 'seedOfficialSource').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
    return seedSource()
  })
  const seed = f.controller.seedOfficialSource()
  await entered.promise
  let drained = false
  const disposing = f.controller.dispose().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish.resolve()
  await seed
  await disposing
  expect(drained).toBe(true)
})

it('keeps catalog reads and mutations on the same pinned review connection', async () => {
  const f = await fixture()
  const client = new PluginEnvironmentProviderRuntimeClient(
    pairedRuntimeConnectionFromOffer(f.host.pairing),
    f.host.runtime.getRuntimeId(),
    () => undefined,
    'management'
  )
  cleanups.push(() => client.close())
  await client.observe()
  expect(await client.manage('state', {})).toMatchObject({ pluginSystemEnabled: true })
  expect(await client.manage('updateSettings', { uiLanguage: 'fr' })).toMatchObject({
    uiLanguage: 'fr'
  })
  expect(f.store.getSettings().uiLanguage).toBe('fr')
  client.close()
  await expect(client.manage('updateSettings', { uiLanguage: 'en' })).rejects.toThrow()
  expect(f.store.getSettings().uiLanguage).toBe('fr')
  const providerOnly = new PluginEnvironmentProviderRuntimeClient(
    pairedRuntimeConnectionFromOffer(f.host.pairing),
    f.host.runtime.getRuntimeId()
  )
  cleanups.push(() => providerOnly.close())
  await expect(providerOnly.manage('state', {})).rejects.toThrow('does not manage plugins')
})
