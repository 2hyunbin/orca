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
import { ensureSshHandlersLoaded } from './ssh'
import { quitTeardownStartGate } from '../../quit-teardown-start-gate'
import { runQuitTasks } from '../../quit-task-registry'
import { connectRegisteredSshTarget } from '../../ssh/targets/ssh-target-registry'

const harness = createSshIpcHarness(mocks)
const target = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

beforeEach(async () => {
  await harness.reset({ load: false })
  mocks.mockSshStore.getTarget.mockReturnValue(target)
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
