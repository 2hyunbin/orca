import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const status: { current: SshManagedServerStatus | undefined } = { current: undefined }
  const os: { current: string } = { current: 'darwin' }
  const connection: { current: { getConnectGeneration: () => number } } = {
    current: { getConnectGeneration: () => 1 }
  }
  return { read: vi.fn(), publish: vi.fn(), os, connection, status }
})

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/u' })
}))
vi.mock('../ssh/orcad-managed-launch-session', () => ({
  readManagedOrcadLaunchSshSession: mocks.read
}))
vi.mock('../ssh/ssh-host-platform-memo', () => ({
  knownSshHostPlatform: () => ({ os: mocks.os.current })
}))
vi.mock('../ssh/ssh-host-server-status', () => ({
  getSshHostServerStatus: () => mocks.status.current
}))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getConnection: () => mocks.connection.current }
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({ publishHostServerStatus: mocks.publish }))

const { forgetLaunchSessionVerdict, noteEndedLaunchSshSession } =
  await import('./ssh-host-launch-session-note')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.os.current = 'darwin'
  mocks.connection.current = { getConnectGeneration: () => 1 }
  mocks.status.current = undefined
  mocks.read.mockResolvedValue('exited')
})

describe('noteEndedLaunchSshSession', () => {
  it('flags a restored host that has no status yet', async () => {
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).toHaveBeenCalledWith('ssh-1', {
      kind: 'managed',
      environmentId: 'env-1',
      launchSessionEnded: true
    })
  })

  it('checks once per SSH connection, and again on a new one', async () => {
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.read).toHaveBeenCalledOnce()
    mocks.connection.current = { getConnectGeneration: () => 1 }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('checks again after the same connection reconnects', async () => {
    let generation = 1
    mocks.connection.current = { getConnectGeneration: () => generation }
    mocks.read.mockResolvedValue('live')
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    generation = 2
    mocks.read.mockResolvedValue('exited')
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('retries when a start or update was still deciding', async () => {
    mocks.status.current = { kind: 'setting-up', phase: 'updating' }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).not.toHaveBeenCalled()
    mocks.status.current = { kind: 'managed', environmentId: 'env-1' }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('reapplies a known ended session to a status a later connect replaced', async () => {
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    mocks.status.current = { kind: 'managed', environmentId: 'env-1' }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.publish).toHaveBeenLastCalledWith('ssh-1', {
      kind: 'managed',
      environmentId: 'env-1',
      launchSessionEnded: true
    })
  })

  it('probes again after a verified restart forgets the verdict', async () => {
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    forgetLaunchSessionVerdict('ssh-1')
    mocks.read.mockResolvedValue('live')
    mocks.status.current = { kind: 'managed', environmentId: 'env-1' }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('never probes a Linux or Windows host', async () => {
    mocks.os.current = 'linux'
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    mocks.os.current = 'win32'
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it.each(['live', 'unverifiable', 'not-recorded'])('shows nothing for %s', async (verdict) => {
    mocks.read.mockResolvedValue(verdict)
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('leaves another server decision alone', async () => {
    mocks.status.current = { kind: 'relay', reason: 'source_changed' }
    await noteEndedLaunchSshSession('ssh-1', 'env-1')
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
