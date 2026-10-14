import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../persistence'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pairedRuntimeRpcFixture } from '../runtime/runtime-paired-rpc-test-fixture'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import {
  createPluginEnvironmentProviderInstallFixture,
  disposePluginEnvironmentProviderInstallFixtures
} from '../plugins/plugin-environment-provider-install-fixture'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import * as capabilities from '../../shared/remote-runtime-client-capabilities'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY } from '../../shared/plugins/plugin-environment-provider-runtime-capability'

const managed = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, webContents: { fromId: vi.fn() } }))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: (...args: unknown[]) => managed.prepare(...args)
}))
import { PluginEnvironmentProviderSessions } from './plugin-environment-provider-sessions'

class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
  getType(): 'window' {
    return 'window'
  }
  getURL(): string {
    return 'file:///orca/index.html'
  }
  isDestroyed(): boolean {
    return false
  }
}
const cleanups: (() => void | Promise<void>)[] = []
beforeEach(() => {
  managed.prepare.mockImplementation(async (root: string, id: string) =>
    resolveEnvironment(root, id)
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setPluginServiceForRpc(null)
  await disposePluginEnvironmentProviderInstallFixtures()
})
async function fixture(
  options: Parameters<typeof createPluginEnvironmentProviderInstallFixture>[0] = {}
) {
  const f = await createPluginEnvironmentProviderInstallFixture({ portable: true, ...options })
  await f.approve()
  setPluginServiceForRpc(f.service)
  const store = new Store({ dataFile: join(f.root, 'profile.json'), serializedState: '{}' })
  cleanups.push(() => store.freezeWritesAsync())
  const host = await pairedRuntimeRpcFixture(cleanups, new OrcaRuntimeService(store), f.root)
  const clientRoot = join(f.root, 'desktop-client')
  await mkdir(clientRoot)
  const environment = addEnvironmentFromPairingCode(clientRoot, {
    name: 'Company control host',
    pairingCode: encodePairingOffer(host.pairing),
    now: 1
  })
  markEnvironmentUsed(clientRoot, environment.id, { runtimeId: host.runtime.getRuntimeId() })
  const notify = vi.fn()
  const changed = vi.fn()
  const sessions = new PluginEnvironmentProviderSessions(
    clientRoot,
    notify,
    (sender) => sender.id < 3,
    changed
  )
  const sender = new Sender(1)
  const input = {
    sessionId: randomUUID(),
    environmentId: environment.id,
    pairingRevision: 1,
    runtimeId: host.runtime.getRuntimeId()
  }
  cleanups.push(() => {
    sender.emit('destroyed')
  })
  return { ...f, host, clientRoot, environment, notify, changed, sessions, sender, input }
}

it('opens an inert host-owned review and routes account and explicit execution through real pairing', async () => {
  const f = await fixture()
  expect(await f.sessions.open(f.sender, f.input)).toEqual({
    sessionId: f.input.sessionId,
    runtimeId: f.input.runtimeId
  })
  expect(
    await f.sessions.call(f.sender, { sessionId: f.input.sessionId, method: 'list', input: {} })
  ).toMatchObject([{ providerId: f.review.providerId }])
  await f.sessions.call(f.sender, {
    sessionId: f.input.sessionId,
    method: 'configure',
    input: { input: f.review }
  })
  await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
  await expect(
    f.sessions.call(f.sender, {
      sessionId: f.input.sessionId,
      method: 'execute',
      input: {
        input: {
          review: f.review,
          request: {
            protocolVersion: 2,
            providerId: f.review.providerId,
            contextId: f.review.contextId,
            operationId: randomUUID(),
            action: 'list'
          }
        }
      }
    })
  ).resolves.toMatchObject({ kind: 'executed', result: { kind: 'completed' } })
  expect((await f.service.environmentProviders.snapshot(f.review)).resources).toMatchObject([
    { id: 'devbox' }
  ])
  expect(f.sessions.close(f.sender, { sessionId: f.input.sessionId })).toBe(true)
  expect(f.sessions.close(f.sender, { sessionId: f.input.sessionId })).toBe(false)
  expect(f.notify).toHaveBeenCalledTimes(1)
})

it('refuses foreign windows and retires on main-frame navigation but not frame or fragment navigation', async () => {
  const f = await fixture()
  await f.sessions.open(f.sender, f.input)
  const call = { sessionId: f.input.sessionId, method: 'list', input: {} }
  await expect(f.sessions.call(new Sender(2), call)).rejects.toThrow('another window')
  expect(() => f.sessions.close(new Sender(2), { sessionId: f.input.sessionId })).toThrow(
    'another window'
  )
  await expect(f.sessions.call(new Sender(3), call)).rejects.toThrow('trusted')
  f.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  f.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  await expect(f.sessions.call(f.sender, call)).resolves.toHaveLength(1)
  f.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await expect(f.sessions.call(f.sender, call)).rejects.toThrow('unavailable')
  expect(f.notify).toHaveBeenCalledTimes(1)
  expect(f.sender.listenerCount('did-start-navigation')).toBe(0)
})

it('rejects stale pairing and arbitrary or injected bridge requests before provider execution', async () => {
  const f = await fixture()
  for (const changed of [
    { pairingRevision: 0 },
    { runtimeId: 'other-instance' },
    { environmentId: 'missing' }
  ]) {
    await expect(
      f.sessions.open(f.sender, { ...f.input, ...changed, sessionId: randomUUID() })
    ).rejects.toThrow()
  }
  await f.sessions.open(f.sender, f.input)
  for (const changed of [
    { method: 'terminal.execute' },
    { input: { runtimeId: f.input.runtimeId } },
    { cwd: f.cwd }
  ]) {
    await expect(
      f.sessions.call(f.sender, {
        sessionId: f.input.sessionId,
        method: 'list',
        input: {},
        ...changed
      })
    ).rejects.toThrow()
  }
  await expect(readFile(join(f.cwd, 'started'))).rejects.toThrow()
})

it('closes a cancelled preparation without admitting a late client or retiring a replacement session', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  managed.prepare.mockImplementationOnce(async (root: string, id: string) => {
    entered.resolve()
    await release.promise
    return resolveEnvironment(root, id)
  })
  const pending = f.sessions.open(f.sender, f.input).then(
    () => 'opened',
    () => 'cancelled'
  )
  await entered.promise
  expect(f.sessions.close(f.sender, { sessionId: f.input.sessionId })).toBe(true)
  await f.sessions.open(f.sender, f.input)
  release.resolve()
  expect(await pending).toBe('cancelled')
  await expect(
    f.sessions.call(f.sender, { sessionId: f.input.sessionId, method: 'list', input: {} })
  ).resolves.toHaveLength(1)
  expect(f.notify).toHaveBeenCalledTimes(1)
})

it('withdraws the selected host session immediately when its transport generation retires', async () => {
  const f = await fixture()
  await f.sessions.open(f.sender, f.input)
  advanceRuntimeEnvironmentTransportGeneration('another-control-host')
  await expect(
    f.sessions.call(f.sender, { sessionId: f.input.sessionId, method: 'list', input: {} })
  ).resolves.toHaveLength(1)
  advanceRuntimeEnvironmentTransportGeneration(f.environment.id)
  await expect(
    f.sessions.call(f.sender, { sessionId: f.input.sessionId, method: 'list', input: {} })
  ).rejects.toThrow('unavailable')
  expect(f.notify).toHaveBeenCalledTimes(1)
})

it('forwards authoritative host changes only to the reviewing window and removes its observer on closure', async () => {
  const f = await fixture()
  await f.sessions.open(f.sender, f.input)
  await f.disableProvider()
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalled())
  expect(f.changed).toHaveBeenCalledWith(
    f.sender,
    f.input.sessionId,
    expect.objectContaining({ contentPacksChanged: true })
  )
  f.sessions.close(f.sender, { sessionId: f.input.sessionId })
  f.changed.mockClear()
  await f.enable()
  await f.service.whenReady()
  expect(f.changed).not.toHaveBeenCalled()
})

it('keeps new plugin events off a real older peer’s otherwise compatible event stream', async () => {
  const f = await fixture()
  const current = capabilities.remoteRuntimeClientCapabilities
  const oldCapabilities = vi
    .spyOn(capabilities, 'remoteRuntimeClientCapabilities')
    .mockImplementation((additional) =>
      current(additional).filter(
        (capability) => capability !== PLUGIN_ENVIRONMENT_PROVIDER_RUNTIME_CAPABILITY
      )
    )
  const events: unknown[] = []
  const errors: unknown[] = []
  const legacy = await subscribeRemoteRuntimeRequest(
    pairedRuntimeConnectionFromOffer(f.host.pairing),
    'runtime.clientEvents.subscribe',
    undefined,
    5000,
    {
      onResponse: (response) => {
        if (response.ok) {
          events.push(response.result)
        }
      },
      onError: (error) => {
        errors.push(error)
      }
    }
  )
  cleanups.push(() => legacy.close())
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'ready' })))
  oldCapabilities.mockRestore()
  await f.sessions.open(f.sender, f.input)
  await f.disableProvider()
  await vi.waitFor(() => expect(f.changed).toHaveBeenCalled())
  if (!legacy.sendRequest) {
    throw new Error('Legacy fixture has no same-socket status barrier')
  }
  await legacy.sendRequest('status.get', undefined, 5000)
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'pluginsChanged' }))
  expect(errors).toEqual([])
})
