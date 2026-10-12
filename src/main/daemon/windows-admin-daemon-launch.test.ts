import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { holdWindowsAdminDaemonLease } from './windows-admin-daemon-launch'
import { DaemonEndpointOwnershipError } from './daemon-endpoint-adoption'
import type * as EndpointIncarnation from './daemon-endpoint-incarnation'
import type * as EndpointAdoption from './daemon-endpoint-adoption'

const mocks = vi.hoisted(() => ({
  readRecord: vi.fn(),
  holdLease: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn()
}))

vi.mock('./daemon-endpoint-incarnation', async (original) => ({
  ...(await original<typeof EndpointIncarnation>()),
  readDaemonPidRecord: mocks.readRecord
}))
vi.mock('./daemon-endpoint-adoption', async (original) => ({
  ...(await original<typeof EndpointAdoption>()),
  holdDaemonAdoptionLease: mocks.holdLease
}))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = mocks.connect
    disconnect = mocks.disconnect
  }
}))

const options = {
  entryPath: '/app/daemon-entry.js',
  forkEntryPath: '/app/daemon-entry.js',
  userDataPath: '/profile',
  socketPath: 'admin-pipe',
  tokenPath: '/profile/admin/token',
  pidPath: '/profile/admin/pid',
  launchNonce: 'requested-launch',
  macosLoginSessionWatch: false
}
const record = { pid: 42, startedAtMs: 100, launchNonce: options.launchNonce }
const handle = { shutdown: async () => {} }

beforeEach(() => {
  vi.useFakeTimers()
  mocks.readRecord.mockReset().mockReturnValue(record)
  mocks.holdLease.mockReset().mockResolvedValue(handle)
  mocks.connect.mockReset().mockResolvedValue(undefined)
  mocks.disconnect.mockReset()
})
afterEach(() => vi.useRealTimers())

it('waits for publication and retries authentication after an old token was read', async () => {
  mocks.readRecord.mockReturnValueOnce(null)
  mocks.connect.mockRejectedValueOnce(new Error('Invalid token'))
  const opening = holdWindowsAdminDaemonLease('/profile/admin', options)
  await vi.runAllTimersAsync()
  expect(await opening).toBe(handle)
  expect(mocks.connect).toHaveBeenCalledTimes(2)
  expect(mocks.disconnect).toHaveBeenCalledOnce()
  expect(mocks.holdLease).toHaveBeenCalledWith(
    expect.objectContaining({ shutdown: expect.any(Function) }),
    expect.objectContaining({ expectedIdentity: record, connectedClient: expect.any(Object) })
  )
})

it('never adopts a replacement when the authenticated owner changed', async () => {
  mocks.holdLease.mockRejectedValueOnce(new DaemonEndpointOwnershipError('Owner changed'))
  await expect(holdWindowsAdminDaemonLease('/profile/admin', options)).rejects.toThrow(
    'Owner changed'
  )
  expect(mocks.connect).toHaveBeenCalledOnce()
  expect(mocks.disconnect).toHaveBeenCalledOnce()
})

it('bounds publication waits and refuses a PID record from a different launch', async () => {
  mocks.readRecord.mockReturnValue({ ...record, launchNonce: 'other-launch' })
  const rejected = expect(holdWindowsAdminDaemonLease('/profile/admin', options)).rejects.toThrow(
    'ownership could not be verified'
  )
  await vi.runAllTimersAsync()
  await rejected
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.holdLease).not.toHaveBeenCalled()
})
