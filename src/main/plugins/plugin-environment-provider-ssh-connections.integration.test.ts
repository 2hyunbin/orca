import { join } from 'node:path'
import { Store } from '../persistence'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pairedRuntimeRpcFixture } from '../runtime/runtime-paired-rpc-test-fixture'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { setEnvironmentProviderSshAuthorizer } from '../ssh/environment-provider-ssh-admission'
import { PluginEnvironmentProviderRuntimeClient } from '../../shared/plugins/plugin-environment-provider-runtime-client'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY } from '../../shared/plugins/plugin-environment-provider-runtime-capability'
import { unwrapRuntimeRpcResult } from '../../shared/runtime-rpc-result'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginEnvironmentProviderController } from './plugin-environment-provider-controller'
import { createProviderSshFixture } from './plugin-environment-provider-ssh-fixture'
import { disposePluginEnvironmentProviderInstallFixtures } from './plugin-environment-provider-install-fixture'
import {
  setSshTargetRegistryStore,
  setSshTargetRegistryHandlers,
  setSshTargetMutations,
  setSshConnectionManagerResolver
} from '../ssh/ssh-target-registry'
import type { SshConnectionState } from '../../shared/ssh-types'

const cleanups: (() => void | Promise<void>)[] = []
const connect = vi.fn()
const ready = (targetId: string): SshConnectionState => ({
  targetId,
  status: 'connected',
  reconnectAttempt: 0,
  error: null
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setPluginServiceForRpc(null)
  setSshTargetMutations(null)
  setSshConnectionManagerResolver(null)
  setEnvironmentProviderSshAuthorizer(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setSshTargetRegistryStore(null)
  vi.restoreAllMocks()
  await disposePluginEnvironmentProviderInstallFixtures()
})
async function fixture() {
  const f = await createProviderSshFixture({ portable: true })
  const controller = new PluginEnvironmentProviderController(f.service.environmentProviders)
  const lifetime = new AbortController()
  const owner = { key: 'socket-a', signal: lifetime.signal }
  controller.bindOwnerSignal(owner.key, owner.signal)
  connect.mockReset().mockImplementation(async (id) => ready(id))
  setSshTargetRegistryHandlers({ connect, getState: (id) => ready(id) })
  const preview = await controller.prepareSsh(owner, {
    operationId: randomUUID(),
    review: f.review,
    resourceId: 'devbox',
    expectedRevision: 'r1'
  })
  const target = await controller.saveSsh(owner, { ticketId: preview.ticketId })
  const request = {
    operationId: randomUUID(),
    targetId: target.id,
    expectedGeneration: target.generation
  }
  return { ...f, controller, owner, lifetime, target, request }
}
it('connects only the target saved by this source review, through the existing host connector', async () => {
  const f = await fixture()
  expect(await f.controller.connectSsh(f.owner, f.request)).toMatchObject({
    targetId: f.target.id,
    status: 'connected'
  })
  expect(connect).toHaveBeenCalledExactlyOnceWith(f.target.id)
})
it('refuses sibling sockets, forged target IDs, changed generations and revoked approval before dialing', async () => {
  const f = await fixture()
  for (const [owner, request] of [
    [{ key: 'socket-b', signal: new AbortController().signal }, f.request],
    [f.owner, { ...f.request, targetId: 'other-host' }],
    [f.owner, { ...f.request, expectedGeneration: (f.target.generation ?? 1) + 1 }]
  ] as const) {
    await expect(f.controller.connectSsh(owner, request)).rejects.toThrow('another review')
  }
  expect(connect).not.toHaveBeenCalled()
  await f.disableProvider()
  await expect(f.controller.connectSsh(f.owner, f.request)).rejects.toThrow()
  expect(connect).not.toHaveBeenCalled()
})
it('checks the saved registration again after asynchronous provider admission', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const authorize = f.ssh.authorize.bind(f.ssh)
  vi.spyOn(f.ssh, 'authorize').mockImplementation(async (target) => {
    const lease = await authorize(target)
    entered.resolve()
    await finish.promise
    return lease
  })
  const call = f.controller.connectSsh(f.owner, f.request)
  const refused = expect(call).rejects.toThrow('changed')
  await entered.promise
  f.store.updateTarget(f.target.id, { identityFile: '/new-identity' })
  finish.resolve()
  await refused
  expect(connect).not.toHaveBeenCalled()
})
it('drops a late connection result after review retirement without redirecting or replaying it', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<SshConnectionState>()
  connect.mockImplementationOnce(async () => {
    entered.resolve()
    return finish.promise
  })
  const call = f.controller.connectSsh(f.owner, f.request)
  const refused = expect(call).rejects.toThrow()
  await entered.promise
  f.lifetime.abort()
  finish.resolve(ready(f.target.id))
  await refused
  expect(connect).toHaveBeenCalledTimes(1)
  await expect(f.controller.connectSsh(f.owner, f.request)).rejects.toThrow()
  expect(connect).toHaveBeenCalledTimes(1)
})
it('does not expose the connector’s private error through the paired provider surface', async () => {
  const f = await fixture()
  connect.mockRejectedValueOnce(new Error('private auth detail'))
  await expect(f.controller.connectSsh(f.owner, f.request)).rejects.toThrow(
    'SSH connection unavailable'
  )
})

it('negotiates SSH support and preserves the saving socket through real encrypted paired RPC', async () => {
  const f = await createProviderSshFixture({ portable: true })
  const profile = new Store({ dataFile: join(f.root, 'rpc-profile.json'), serializedState: '{}' })
  cleanups.push(() => profile.freezeWritesAsync())
  const manager = new SshConnectionManager({ onStateChange: () => undefined })
  setSshConnectionManagerResolver(() => manager)
  setSshTargetMutations({
    add: (target) => ({ target: f.store.addTarget(target), repoReadoptions: [] }),
    update: (id, updates) => f.store.updateTarget(id, updates),
    remove: async (id) => {
      f.store.removeTarget(id)
    }
  })
  setEnvironmentProviderSshAuthorizer((target) => f.ssh.authorize(target))
  connect.mockReset().mockImplementation(async (id) => ready(id))
  setSshTargetRegistryHandlers({ connect, getState: (id) => ready(id) })
  setPluginServiceForRpc(f.service)
  const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(profile), f.root)
  const pairing = pairedRuntimeConnectionFromOffer(host.pairing)
  const client = new PluginEnvironmentProviderRuntimeClient(pairing, host.runtime.getRuntimeId())
  cleanups.push(() => client.close())
  await client.ready()
  expect(client.supportsProviderSsh()).toBe(true)
  const preview = await client.call('prepareSsh', {
    input: {
      operationId: randomUUID(),
      review: f.review,
      resourceId: 'devbox',
      expectedRevision: 'r1'
    }
  })
  const target = await client.call('saveSsh', { input: { ticketId: preview.ticketId } })
  const request = {
    operationId: randomUUID(),
    targetId: target.id,
    expectedGeneration: target.generation ?? 0
  }
  const sibling = new PluginEnvironmentProviderRuntimeClient(pairing, host.runtime.getRuntimeId())
  cleanups.push(() => sibling.close())
  await expect(sibling.call('connectSsh', { input: request })).rejects.toThrow('another review')
  expect(connect).not.toHaveBeenCalled()
  expect(await client.call('connectSsh', { input: request })).toMatchObject({
    targetId: target.id,
    status: 'connected'
  })
  expect(connect).toHaveBeenCalledExactlyOnceWith(target.id)
  const legacy = host.connect([])
  expect(
    await legacy.request(
      'plugins.environments.connectSsh',
      { runtimeId: host.runtime.getRuntimeId(), input: request },
      5000
    )
  ).toMatchObject({ ok: false })
  setSshConnectionManagerResolver(null)
  expect(
    unwrapRuntimeRpcResult(await host.connect().request('status.get', undefined, 5000))
  ).toMatchObject({
    capabilities: expect.not.arrayContaining([PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY])
  })
})

it('keeps provider shutdown pending until an accepted connection settles', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<SshConnectionState>()
  connect.mockImplementationOnce(async () => {
    entered.resolve()
    return finish.promise
  })
  const call = f.controller.connectSsh(f.owner, f.request)
  const refused = expect(call).rejects.toThrow()
  await entered.promise
  let disposed = false
  const disposing = f.service.environmentProviders.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  finish.resolve(ready(f.target.id))
  await refused
  await disposing
  expect(disposed).toBe(true)
})
