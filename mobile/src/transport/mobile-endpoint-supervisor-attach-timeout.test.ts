import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_RELAY_PHONE_CLOSE_REASON } from '../../../src/shared/mobile-relay-close-codes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const movedRelay = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
// The fakes' fixed jitter puts the known-offline wait at 5039ms.
const HOST_OFFLINE_WAIT_MS = 5_039

function attachTimeout(): RelayOuterError {
  return new RelayOuterError(4404, true, MOBILE_RELAY_PHONE_CLOSE_REASON.HOST_ATTACH_TIMEOUT)
}

// A cell that refuses every relay dial with `failure` until `succeedAfter` dials.
function cellRefusing(failure: () => Error, succeedAfter = Number.POSITIVE_INFINITY) {
  const logical = new FakeLogicalClient('disconnected', 'lan')
  const migrateTo = logical.migrateTo.getMockImplementation()!
  let dials = 0
  logical.migrateTo.mockImplementation(async (session: RpcClient, ...rest) => {
    dials += 1
    if (dials > succeedAfter) {
      return migrateTo(session, ...rest)
    }
    session.close()
    throw failure()
  })
  const openRelay = vi.fn<MobileEndpointSupervisorDependencies['openRelay']>(
    () => new FakeRelaySession('connected')
  )
  return { logical, openRelay }
}

function start(
  logical: FakeLogicalClient,
  overrides: Partial<MobileEndpointSupervisorDependencies>
): MobileEndpointSupervisor {
  const supervisor = new MobileEndpointSupervisor(
    logical,
    host.id,
    relay,
    dependencies({
      // Why: a reachable direct path would win and end relay recovery mid-test.
      openDirect: vi.fn(() => new FakeRelaySession('disconnected')),
      ...overrides
    })
  )
  return supervisor
}

describe('relay dial refused because the desktop data link missed its attach deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('re-resolves through the director at once and dials the cell it names', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout, 1)
    const resolveRelay = vi.fn(async () => movedRelay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()

    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(openRelay.mock.calls[1]?.[0].cellUrl).toBe(movedRelay.cellUrl)
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('falls back to the known-offline wait when the retry fails the same way', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const resolveRelay = vi.fn(async () => movedRelay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS)
    expect(openRelay).toHaveBeenCalledTimes(4)
    // The quick re-resolve is spent for this outage.
    expect(resolveRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('does not redial a cell the director still names', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const resolveRelay = vi.fn(async () => relay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()

    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('honours a director Retry-After on the quick re-resolve and spends the retry', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const resolveRelay = vi.fn(async () => {
      throw new RelayDirectorHttpError(503, 5_000)
    })
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(resolveRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('keeps the known-offline wait for a 4404 without the reason', async () => {
    const { logical, openRelay } = cellRefusing(() => new RelayOuterError(4404, true))
    const resolveRelay = vi.fn(async () => movedRelay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()

    expect(resolveRelay).not.toHaveBeenCalled()
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('earns a fresh quick retry when the app returns to the foreground', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const resolveRelay = vi.fn(async () => movedRelay)
    const supervisor = start(logical, { openRelay, resolveRelay })
    await supervisor.start()
    expect(resolveRelay).toHaveBeenCalledOnce()

    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(resolveRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })
})
