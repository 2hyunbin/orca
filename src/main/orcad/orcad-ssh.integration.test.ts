import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../persistence'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcadRuntimeLifetime } from './orcad-runtime-lifetime'
import { startOrcadSsh } from './orcad-ssh'
import { startOrcadPlugins } from './orcad-plugins'
import { PluginKillListService } from '../plugins/plugin-kill-list-service'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from '../plugins/plugin-environment-provider-install-fixture'
import { providerFixtureConnection } from '../plugins/plugin-environment-provider-ssh-fixture'
import { pairedRuntimeRpcFixture } from '../runtime/runtime-paired-rpc-test-fixture'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { PluginEnvironmentProviderRuntimeClient } from '../../shared/plugins/plugin-environment-provider-runtime-client'
import { unwrapRuntimeRpcResult } from '../../shared/runtime-rpc-result'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from '../../shared/ssh-target-management'
import { PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY } from '../../shared/plugins/plugin-environment-provider-runtime-capability'
import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getRegisteredSshTargetMutations,
  getSshTargetRegistryStore
} from '../ssh/ssh-target-registry'
import { admitEnvironmentProviderSshTarget } from '../ssh/environment-provider-ssh-admission'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { resetSshShutdownDrain } from '../ipc/ssh-shutdown-drain'
import { SshConnection } from '../ssh/ssh-connection'
import { handleSshConnectionStateChange } from '../ssh/ssh-connection-state-publisher'
import { beginSshHostCensus } from '../ssh/ssh-connection-attribution'
import * as hostServerDecision from '../ssh/ssh-host-server-on-connect'
import * as managedLifecycle from '../ssh/orcad-runtime-lifecycle'
import { getManagedServerActions } from '../runtime/managed-server-actions-registry'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const cleanups: (() => void | Promise<void>)[] = []
beforeEach(() => {
  quitTeardownStartGate.resetForTests()
  resetSshShutdownDrain()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await closeTestStores()
  await disposePluginEnvironmentProviderInstallFixtures()
})
async function fixture() {
  const f = await createPluginEnvironmentProviderInstallFixture({ portable: true })
  await f.service.dispose()
  const store = createSqliteTestStore(Store, {
    dataFile: join(f.root, 'ssh-profile.json'),
    storageAuthority: 'runtime'
  })
  store.updateSettings({ pluginSystemEnabled: true })
  const lifetime = new OrcadRuntimeLifetime()
  lifetime.add(() => store.freezeWritesAsync())
  cleanups.push(() => lifetime.stop())
  const runtime = new OrcaRuntimeService(store)
  expect(runtime.getStatus().capabilities).not.toContain(SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY)
  const ssh = startOrcadSsh({
    store,
    runtime,
    userDataPath: f.service.options.userDataPath,
    registerCleanup: (cleanup) => lifetime.add(cleanup)
  })
  const service = await startOrcadPlugins({
    store,
    userDataPath: f.service.options.userDataPath,
    hostVersion: '1.4.0',
    registerCleanup: (cleanup) => lifetime.add(cleanup),
    marketplaceFetcher: async () => {
      throw new Error('Offline test catalog')
    },
    safetyList: new PluginKillListService({
      pluginsDataDir: getPluginsDataDir(f.service.options.userDataPath),
      fetcher: async () => ({ version: 1, generatedAt: new Date().toISOString(), plugins: [] })
    }),
    launchEnvironment: f.service.options.getEnvironmentRecipeLaunchEnvironment
  })
  return { ...f, store, service, lifetime, runtime, ...ssh }
}
async function pairedProvider() {
  const f = await fixture()
  const host = await pairedRuntimeRpcFixture(cleanups, f.runtime, f.root)
  const client = new PluginEnvironmentProviderRuntimeClient(
    pairedRuntimeConnectionFromOffer(host.pairing),
    f.runtime.getRuntimeId()
  )
  cleanups.push(() => client.close())
  const plugin = f.service.findValidPlugin('company.platform')
  if (!plugin?.reviewRevision) {
    throw new Error('Installed Node provider is missing')
  }
  const connection = host.connect()
  unwrapRuntimeRpcResult(
    await connection.request(
      'plugins.consent',
      {
        pluginKey: plugin.pluginKey,
        reviewedFingerprint: plugin.consentFingerprint,
        reviewedRevision: plugin.reviewRevision,
        decision: 'approve'
      },
      5000
    )
  )
  await client.call('configure', { input: f.review })
  await writeFile(
    join(f.cwd, 'backend.json'),
    JSON.stringify({
      devbox: {
        id: 'devbox',
        name: 'Existing devbox',
        revision: 'r1',
        state: 'running',
        lifetime: 'long-lived',
        connection: providerFixtureConnection
      }
    })
  )
  const preview = await client.call('prepareSsh', {
    input: {
      operationId: randomUUID(),
      review: f.review,
      resourceId: 'devbox',
      expectedRevision: 'r1'
    }
  })
  const target = await client.call('saveSsh', { input: { ticketId: preview.ticketId } })
  if (!target.generation) {
    throw new Error('Saved target has no durable generation')
  }
  return { ...f, client, host, target, generation: target.generation }
}
it('advertises only a composed Node SSH stack and uses the same protected mutation rules', async () => {
  const f = await fixture()
  expect(f.runtime.getStatus().capabilities).toContain(SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY)
  expect(f.runtime.getStatus().capabilities).toContain(MANAGED_SERVER_RUNTIME_CAPABILITY)
  expect(f.runtime.getStatus().capabilities).toContain(
    PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY
  )
  const forged = {
    label: 'Owned target',
    host: '127.0.0.1',
    port: 9,
    username: 'owned-fixture',
    generation: 900,
    environmentProvider: { providerId: 'unreviewed' },
    orcadFence: { environmentId: 'forged' }
  }
  const { target } = getRegisteredSshTargetMutations().add(forged)
  expect(target.generation).not.toBe(900)
  expect(target.environmentProvider).toBeUndefined()
  expect(target.orcadFence).toBeUndefined()
  f.store.updateSshTarget(target.id, { orcadFence: { environmentId: 'owned-server' } })
  await expect(getRegisteredSshTargetMutations().remove(target.id)).rejects.toThrow(
    'managed Orca server'
  )
  expect(f.store.getSshTarget(target.id)).toBeDefined()
  expect(() =>
    startOrcadSsh({
      store: f.store,
      runtime: f.runtime,
      userDataPath: f.root,
      registerCleanup: () => undefined
    })
  ).toThrow('already registered')
})
it('saves provider SSH registrations on the Node profile and refuses wrong generations before dialing', async () => {
  const f = await pairedProvider()
  expect(f.client.supportsProviderSsh()).toBe(true)
  expect(f.store.getSshTarget(f.target.id)).toEqual(f.target)
  await expect(
    f.client.call('connectSsh', {
      input: {
        operationId: randomUUID(),
        targetId: f.target.id,
        expectedGeneration: f.generation + 1
      }
    })
  ).rejects.toThrow('changed or belongs to another review')
  expect(f.connectionManager.getConnection(f.target.id)).toBeUndefined()
  await f.lifetime.stop()
  expect(f.store.getSshTarget(f.target.id)).toEqual(f.target)
  expect(JSON.parse(readPersistedStateJson(join(f.root, 'ssh-profile.json')))).toMatchObject({
    sshTargets: expect.arrayContaining([
      expect.objectContaining({
        id: f.target.id,
        environmentProvider: f.target.environmentProvider
      })
    ])
  })
  expect(getSshTargetRegistryStore()).toBeNull()
  expect(f.runtime.getStatus().capabilities).not.toContain(SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY)
  expect(f.runtime.getStatus().capabilities).not.toContain(MANAGED_SERVER_RUNTIME_CAPABILITY)
  expect(f.runtime.getStatus().capabilities).not.toContain(
    PLUGIN_ENVIRONMENT_PROVIDER_SSH_RUNTIME_CAPABILITY
  )
})
it('retires the Node provider lease on withdrawal while retaining the machine and durable inventory', async () => {
  const f = await pairedProvider()
  const lease = await admitEnvironmentProviderSshTarget(f.target)
  expect(lease?.isCurrent()).toBe(true)
  f.store.updateSettings({ pluginConsents: {} }, { notifyListeners: true })
  await vi.waitFor(() => expect(lease?.signal.aborted).toBe(true))
  expect(f.store.getSshTarget(f.target.id)).toEqual(f.target)
  await expect(admitEnvironmentProviderSshTarget(f.target)).rejects.toThrow('approval')
  expect(await readFile(join(f.cwd, 'backend.json'), 'utf8')).toContain('devbox')
})
it('fences new connects and waits for the existing SSH drain before releasing the Node profile', async () => {
  const f = await fixture()
  const draining = Promise.withResolvers<void>()
  const disconnect = vi
    .spyOn(f.connectionManager, 'disconnectAll')
    .mockImplementation(() => draining.promise)
  const stopped = f.lifetime.stop()
  let released = false
  void stopped.then(() => {
    released = true
  })
  try {
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce())
    expect(quitTeardownStartGate.hasStarted()).toBe(true)
    await expect(connectRegisteredSshTarget('any-target')).rejects.toThrow('shutdown')
    expect(released).toBe(false)
  } finally {
    draining.resolve()
    await stopped
  }
  expect(released).toBe(true)
  expect(getSshTargetRegistryStore()).toBeNull()
})

it('keeps raw transport readiness private until the shared managed-server decision completes', async () => {
  const f = await fixture()
  const { target } = getRegisteredSshTargetMutations().add({
    label: 'Owned decision fixture',
    host: '127.0.0.1',
    port: 9,
    username: 'owned-fixture'
  })
  const ready = {
    targetId: target.id,
    status: 'connected' as const,
    reconnectAttempt: 0,
    error: null
  }
  vi.spyOn(SshConnection.prototype, 'getState').mockReturnValue(ready)
  vi.spyOn(SshConnection.prototype, 'connect').mockImplementation(async () => {
    handleSshConnectionStateChange(target.id, ready)
  })
  const decision = Promise.withResolvers<hostServerDecision.HostServerOnConnectResult>()
  vi.spyOn(hostServerDecision, 'resolveHostServerOnConnect').mockImplementation(async (saved) => {
    await f.connectionManager.connect(saved)
    return decision.promise
  })
  const host = await pairedRuntimeRpcFixture(cleanups, f.runtime, f.root)
  const client = host.connect()
  const publish = vi.spyOn(f.runtime, 'notifySshStateChanged')
  const pending = connectRegisteredSshTarget(target.id)
  try {
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        target.id,
        expect.objectContaining({ status: 'connecting' })
      )
    )
    expect(publish.mock.calls.some(([, state]) => state.status === 'connected')).toBe(false)
    expect(getRegisteredSshState(target.id)).toMatchObject({ status: 'connecting' })
    const observed = unwrapRuntimeRpcResult(
      await client.request<{ state: { status: string } }>(
        'ssh.getState',
        { targetId: target.id },
        5000
      )
    )
    expect(observed.state.status).toBe('connecting')
  } finally {
    decision.resolve({ route: 'managed', environmentId: 'owned-managed-fixture' })
  }
  expect(await pending).toMatchObject({
    status: 'connected',
    managedServer: { kind: 'managed', environmentId: 'owned-managed-fixture' }
  })
  expect(publish).toHaveBeenCalledWith(target.id, expect.objectContaining({ status: 'connected' }))
  const settled = unwrapRuntimeRpcResult(
    await client.request<{ state: { status: string } }>(
      'ssh.getState',
      { targetId: target.id },
      5000
    )
  )
  expect(settled.state.status).toBe('connected')
  const finishCensus = beginSshHostCensus(target.id)
  try {
    const censusing = unwrapRuntimeRpcResult(
      await client.request<{ state: { status: string } }>(
        'ssh.getState',
        { targetId: target.id },
        5000
      )
    )
    expect(censusing.state.status).toBe('connecting')
  } finally {
    finishCensus()
  }
  expect(getRegisteredSshState(target.id)).toMatchObject({ status: 'connected' })
})

it('closes managed-server admission and drains accepted maintenance before the Node profile freezes', async () => {
  const f = await fixture()
  const actions = getManagedServerActions()
  if (!actions) {
    throw new Error('Node managed-server actions are missing')
  }
  const pending =
    Promise.withResolvers<
      Awaited<ReturnType<typeof managedLifecycle.updateManagedOrcadEnvironment>>
    >()
  const update = vi
    .spyOn(managedLifecycle, 'updateManagedOrcadEnvironment')
    .mockReturnValue(pending.promise)
  const result = actions.update('owned-fixture', false).catch((error: unknown) => error)
  expect(update).toHaveBeenCalledOnce()
  const stopped = f.lifetime.stop()
  let released = false
  void stopped.then(() => {
    released = true
  })
  try {
    await vi.waitFor(() => expect(getManagedServerActions()).toBeNull())
    await expect(actions.update('another-fixture', false)).rejects.toThrow('shutting down')
    expect(released).toBe(false)
    await expect(f.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
    expect(getSshTargetRegistryStore()).toBe(f.sshStore)
  } finally {
    pending.reject(new Error('Owned fixture maintenance finished'))
    expect(await result).toBeInstanceOf(Error)
    await stopped
  }
  expect(released).toBe(true)
})
