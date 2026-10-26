import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})
vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('./ssh-port-scanner', () => mocks.sshPortScanner)

import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { ensureSshHandlersLoaded, registerSshHandlers } from './ssh'
import { connectionManager, getCurrentMainWindow, persistedStore } from './ssh-ipc-context'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import { runQuitTasks } from '../../quit-task-registry'
import { connectRegisteredSshTarget } from '../../ssh/targets/ssh-target-registry'

const harness = createSshIpcHarness(mocks)
const target = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

beforeEach(async () => {
  await harness.reset({ load: false })
  mocks.mockSshStore.getTarget.mockReturnValue(target)
  const decide = mocks.hostServerConnect.decideHostServer
  if (vi.isMockFunction(decide)) {
    decide.mockClear()
  }
})

describe('SSH startup boundary', () => {
  it('registers connect, credential and compatibility channels before loading transports', async () => {
    for (const channel of [
      'ssh:connect',
      'ssh:testConnection',
      'ssh:submitCredential',
      'plainSsh:open',
      'legacyRelayBridge:attach',
      'ssh:browseDir'
    ]) {
      expect(harness.handlers.has(channel)).toBe(true)
    }
    expect(await harness.handlers.get('ssh:listTargets')!(null, undefined)).toEqual([])
    expect(harness.handlers.get('ssh:getState')!(null, { targetId: target.id })).toBeUndefined()
    expect(harness.handlers.get('ssh:listPortForwards')!(null, undefined)).toEqual([])
    expect(mocks.mockConnectionManager.callbacksRef.current).toBeNull()
    expect(mocks.powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('loads once for concurrent first connects including the paired/serve API', async () => {
    const first = harness.handlers.get('ssh:connect')!(null, { targetId: target.id })
    const second = connectRegisteredSshTarget(target.id)
    await Promise.all([first, second])
    expect(vi.mocked(mocks.hostServerConnect.decideHostServer)).toHaveBeenCalledOnce()
    expect(mocks.powerMonitorOnMock).toHaveBeenCalledTimes(2)
    expect(mocks.mockConnectionManager.callbacksRef.current).not.toBeNull()
  })

  it('keeps a first-load test probe working without starting a managed host', async () => {
    mocks.mockConnectionManager.connect.mockResolvedValue({
      getState: () => ({ status: 'connected' })
    })
    await expect(
      harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    ).resolves.toEqual({ success: true, state: { status: 'connected' } })
    expect(mocks.mockConnectionManager.disconnect).toHaveBeenCalledWith(target.id)
    expect(mocks.mockPortForwardManager.callbacksRef.current).toBeNull()
    expect(mocks.powerMonitorOnMock).not.toHaveBeenCalled()
    expect(mocks.hostServerConnect.decideHostServer).not.toHaveBeenCalled()

    const manager = connectionManager
    const store = persistedStore
    if (!store) {
      throw new Error('SSH store was not registered')
    }
    const mainWindow = getCurrentMainWindow()
    registerSshHandlers(store, () => mainWindow)
    await ensureSshHandlersLoaded()
    expect(connectionManager).toBe(manager)
    expect(mocks.mockPortForwardManager.callbacksRef.current).not.toBeNull()
    expect(mocks.powerMonitorOnMock).toHaveBeenCalledTimes(2)
  })

  it('retries managed setup after a successful probe without replacing its transport owner', async () => {
    mocks.mockConnectionManager.connect.mockResolvedValue({
      getState: () => ({ status: 'connected' })
    })
    await harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    const manager = connectionManager
    mocks.mockPortForwardManager.setCallbacks.mockImplementationOnce(() => {
      throw new Error('forward setup failed')
    })
    await expect(ensureSshHandlersLoaded()).rejects.toThrow('forward setup failed')
    await expect(ensureSshHandlersLoaded()).resolves.toBeUndefined()
    expect(connectionManager).toBe(manager)
    await expect(
      harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    ).resolves.toMatchObject({ success: true })
  })

  it('cancels credentials on a cold probe and drains its transport without starting managed owners', async () => {
    const opened = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    let credential: Promise<string | null> | undefined
    mocks.mockConnectionManager.connect.mockImplementationOnce(async () => {
      const callbacks = mocks.mockConnectionManager.callbacksRef.current
      if (
        !callbacks ||
        typeof callbacks !== 'object' ||
        !('onCredentialRequest' in callbacks) ||
        typeof callbacks.onCredentialRequest !== 'function'
      ) {
        throw new Error('transport credentials not installed')
      }
      credential = callbacks.onCredentialRequest?.(target.id, 'password', target.host)
      opened.resolve()
      const value = await credential
      released.resolve()
      if (value === null) {
        throw new Error('credential cancelled')
      }
      return { getState: () => ({ status: 'connected' }) }
    })
    const probe = harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    await opened.promise
    const request = harness.mockWindow.webContents.send.mock.calls.find(
      ([channel]) => channel === 'ssh:credential-request'
    )?.[1]
    expect(request?.requestId).toBeTypeOf('string')
    await harness.handlers.get('ssh:submitCredential')!(null, {
      requestId: request.requestId,
      value: null
    })
    await released.promise
    await expect(probe).resolves.toEqual({ success: false, error: 'credential cancelled' })
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    await runQuitTasks('ssh', { isUpdate: false, shutdownDaemon: false })
    expect(mocks.mockConnectionManager.disconnectAll).toHaveBeenCalled()
    expect(mocks.mockPortForwardManager.callbacksRef.current).toBeNull()
    expect(mocks.powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('joins a late transport from a cold probe before the final quit drain', async () => {
    const opened = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<{ getState: () => { status: string } }>()
    mocks.mockConnectionManager.connect.mockImplementationOnce(() => {
      opened.resolve()
      return finish.promise
    })
    const probe = harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    await opened.promise
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    let drained = false
    const shutdown = runQuitTasks('ssh', { isUpdate: false, shutdownDaemon: false }).then(() => {
      drained = true
    })
    expect(drained).toBe(false)
    finish.resolve({ getState: () => ({ status: 'connected' }) })
    await shutdown
    await expect(probe).resolves.toMatchObject({ success: true })
    expect(mocks.mockConnectionManager.disconnect).toHaveBeenCalledWith(target.id)
    expect(mocks.mockConnectionManager.disconnectAll).toHaveBeenCalledTimes(2)
    expect(mocks.mockPortForwardManager.callbacksRef.current).toBeNull()
  })

  it('rejects a queued cold probe when committed quit wins loading', async () => {
    const probe = harness.handlers.get('ssh:testConnection')!(null, { targetId: target.id })
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    await expect(probe).rejects.toThrow('app shutdown')
    expect(mocks.mockConnectionManager.callbacksRef.current).toBeNull()
  })

  it('registers shutdown before a partial initialization can fail', async () => {
    const forwards = harness.createPortForwardManagerMock()
    forwards.setCallbacks.mockImplementationOnce(() => {
      throw new Error('forward setup failed')
    })
    mocks.mockNextPortForwardManagers.push(forwards)
    await expect(ensureSshHandlersLoaded()).rejects.toThrow('forward setup failed')
    expect(mocks.mockConnectionManager.callbacksRef.current).not.toBeNull()
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    await runQuitTasks('ssh', { isUpdate: false, shutdownDaemon: false })
    expect(mocks.mockConnectionManager.disconnectAll).toHaveBeenCalled()
    expect(forwards.closeAll).toHaveBeenCalled()
  })

  it('does not initialize a queued first use after committed quit', async () => {
    const pending = ensureSshHandlersLoaded()
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    await expect(pending).rejects.toThrow('app shutdown')
    expect(mocks.mockConnectionManager.callbacksRef.current).toBeNull()
    expect(mocks.powerMonitorOnMock).not.toHaveBeenCalled()
  })
})
