import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { RelayHostHelloAckMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'

type FakeControl = {
  options: {
    cellUrl: string
    onDrain(message: { type: 'drain'; graceMs: number; recovery: 'resolve-director' }): void
    onClose(code: number): void
    previousGeneration?: number
    controlResumeSecret?: string
  }
}

const fakes = vi.hoisted(() => {
  const controls: FakeControl[] = []
  return { controls, controlConnect: vi.fn(), assign: vi.fn() }
})

vi.mock('./relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClientModule>()),
  requestRelayAssignment: fakes.assign
}))

vi.mock('./relay-control-client', () => ({
  RelayControlClient: class {
    connect = fakes.controlConnect
    closeNow = vi.fn()
    isLive = vi.fn(() => true)
    pendingRequestCount = 0

    constructor(readonly options: FakeControl['options']) {
      fakes.controls.push(this)
    }
  }
}))

vi.mock('../rpc/relay-transport', () => ({
  CloudRelayTransport: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = vi.fn()
    metadataFor = vi.fn()
    hasConnection = vi.fn(() => false)
    openConnection = vi.fn().mockResolvedValue(undefined)
  }
}))

import { RelayOriginPool } from './relay-origin-pool'
import { RelayHttpError } from './relay-http-client'
import { RelayControlClosedError } from './relay-control-closed-error'

const CELL = 'https://relay-c1.example.test'
const ACK: RelayHostHelloAckMessage = {
  type: 'host-hello-ack',
  v: 1,
  generation: 7,
  controlResumeSecret: 'R'.repeat(43),
  leaseExpiresAt: 1_000_000,
  activeConnIds: [],
  pendingConns: []
}
const DRAIN = { type: 'drain' as const, graceMs: 5_000, recovery: 'resolve-director' as const }

function assignment(cellUrl: string, assignmentEpoch: number) {
  return { v: 1 as const, cellUrl, assignmentEpoch, lease: 'assignment-lease' }
}

async function openPool(onStatus = vi.fn()): Promise<RelayOriginPool> {
  const keypair = nacl.box.keyPair()
  const pool = new RelayOriginPool({
    directorUrl: 'https://relay.example.test',
    relayHostId: 'host-1',
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.0.0',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: origins call only attachTransport, which this fake implements.
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    isCurrent: () => true,
    onStatus,
    // Half jitter: reattach waits 500 ms; director retries wait 500 ms, 1 s, 2 s...
    random: () => 0.5,
    // Keeps the hello-ack lease far from expiry so rotation stays idle.
    now: () => 0
  })
  await pool.openInitial(assignment(CELL, 3), 'relay-jwt')
  return pool
}

describe('RelayOriginPool last-cell reattach', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakes.controls.length = 0
    fakes.controlConnect.mockReset().mockResolvedValue(ACK)
    fakes.assign.mockReset().mockRejectedValue(new Error('fetch failed'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resumes the last cell when the director is unreachable after a socket loss', async () => {
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(499)
    expect(fakes.controls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(onStatus).toHaveBeenLastCalledWith('registered')
    expect(fakes.assign).toHaveBeenCalledTimes(1)
    expect(fakes.controls).toHaveLength(2)
    expect(fakes.controls[1]!.options.cellUrl).toBe(CELL)
    expect(fakes.controls[1]!.options.previousGeneration).toBe(7)
    expect(fakes.controls[1]!.options.controlResumeSecret).toBe('R'.repeat(43))
    expect(pool.activeAssignment?.assignmentEpoch).toBe(3)
    pool.closeNow()
  })

  it('keeps a cell-silence close (4408) eligible', async () => {
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(4408)
    await vi.advanceTimersByTimeAsync(500)

    expect(onStatus).toHaveBeenLastCalledWith('registered')
    expect(fakes.controls).toHaveLength(2)
    pool.closeNow()
  })

  it('opens a fresh generation on the last cell when it lost the resume secret', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new Error('invalid host challenge: transcript:resumeRequested'))
      .mockResolvedValueOnce({ ...ACK, generation: 1, controlResumeSecret: 'N'.repeat(43) })
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)

    expect(onStatus).toHaveBeenLastCalledWith('registered')
    expect(fakes.controls).toHaveLength(3)
    expect(fakes.controls[2]!.options.cellUrl).toBe(CELL)
    expect(fakes.controls[2]!.options.controlResumeSecret).toBeUndefined()
    pool.closeNow()
  })

  it('follows a director answer instead of the last cell', async () => {
    fakes.assign.mockReset().mockResolvedValue(assignment('https://relay-c2.example.test', 4))
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(0)

    expect(onStatus).toHaveBeenLastCalledWith('registered')
    expect(fakes.controls).toHaveLength(2)
    expect(fakes.controls[1]!.options.cellUrl).toBe('https://relay-c2.example.test')
    pool.closeNow()
  })

  it('does not return to the last cell when dialing the director-named cell fails', async () => {
    fakes.assign.mockReset().mockResolvedValue(assignment('https://relay-c2.example.test', 4))
    fakes.controlConnect.mockResolvedValueOnce(ACK).mockRejectedValue(new Error('ECONNREFUSED'))
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.controls.length).toBeGreaterThan(2)
    expect(fakes.controls.slice(1).map((control) => control.options.cellUrl)).toEqual(
      fakes.controls.slice(1).map(() => 'https://relay-c2.example.test')
    )
    pool.closeNow()
  })

  it('drops the last cell once the director has answered, even if that answer fails to dial', async () => {
    fakes.assign
      .mockReset()
      .mockResolvedValueOnce(assignment('https://relay-c2.example.test', 4))
      .mockRejectedValue(new Error('fetch failed'))
    fakes.controlConnect.mockResolvedValueOnce(ACK).mockRejectedValue(new Error('ECONNREFUSED'))
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.assign.mock.calls.length).toBeGreaterThan(1)
    expect(fakes.controls.map((control) => control.options.cellUrl)).toEqual([
      CELL,
      'https://relay-c2.example.test'
    ])
    pool.closeNow()
  })

  it.each([
    ['a redirect close (4503)', 4503],
    ['a redirect close (4409)', 4409],
    ['an auth close (4401)', 4401]
  ])('waits for the director after %s', async (_name, code) => {
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(code)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.assign.mock.calls.length).toBeGreaterThan(1)
    expect(fakes.controls).toHaveLength(1)
    pool.closeNow()
  })

  it('waits for the director when the loss followed a drain frame', async () => {
    const pool = await openPool()

    fakes.controls[0]!.options.onDrain(DRAIN)
    await vi.advanceTimersByTimeAsync(0)
    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.assign.mock.calls.length).toBeGreaterThan(1)
    expect(fakes.controls).toHaveLength(1)
    pool.closeNow()
  })

  it('waits for the director after a definitive director refusal', async () => {
    fakes.assign.mockReset().mockRejectedValue(new RelayHttpError('assignment', 400))
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.controls).toHaveLength(1)
    pool.closeNow()
  })

  it('stops trying a cell that refused the reattach, without a fresh-generation retry', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new RelayControlClosedError(4409, null))
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.controls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fakes.assign.mock.calls.length).toBeGreaterThan(1)
    expect(fakes.controls).toHaveLength(2)
    pool.closeNow()
  })

  it('retries the last cell on a later attempt after a transport failure', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    // Resume, then fresh generation, both refused by the socket.
    expect(fakes.controls).toHaveLength(3)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onStatus).toHaveBeenLastCalledWith('registered')
    expect(fakes.controls).toHaveLength(4)
    expect(fakes.controls[3]!.options.cellUrl).toBe(CELL)
    pool.closeNow()
  })

  it('does not reattach behind a newer parked assignment', async () => {
    const pool = await openPool()
    expect(pool.applyAssignmentMetadata(assignment(CELL, 4))).toBe(true)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.assign.mock.calls.length).toBeGreaterThan(1)
    expect(fakes.controls).toHaveLength(1)
    pool.closeNow()
  })

  it('paces a control that drops again right after reattaching', async () => {
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.controls).toHaveLength(2)

    fakes.controls[1]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fakes.controls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fakes.controls).toHaveLength(3)
    expect(onStatus).toHaveBeenLastCalledWith('registered')
    pool.closeNow()
  })

  it('honors a drain re-sent while the reattach completes', async () => {
    let resolveResume!: (ack: RelayHostHelloAckMessage) => void
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockReturnValueOnce(new Promise((resolve) => (resolveResume = resolve)))
    const onStatus = vi.fn()
    const pool = await openPool(onStatus)

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.controls).toHaveLength(2)
    fakes.controls[1]!.options.onDrain(DRAIN)
    resolveResume(ACK)
    await vi.advanceTimersByTimeAsync(0)
    expect(onStatus).toHaveBeenLastCalledWith('draining')
    expect(fakes.assign).toHaveBeenCalledTimes(1)

    // Through the backoff, so a cell re-sending its drain cannot loop the director.
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.assign).toHaveBeenCalledTimes(2)
    pool.closeNow()
  })

  it('keeps the backoff count after a reattach', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new RelayControlClosedError(4409, null))
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(1006)
    // First attempt fails at the cell; the 500 ms retry reattaches after the 5 s pacing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fakes.controls).toHaveLength(4)
    const assignsBefore = fakes.assign.mock.calls.length

    fakes.controls[3]!.options.onClose(1006)
    while (fakes.controls.length < 5) {
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(fakes.assign.mock.calls.length).toBe(assignsBefore + 1)
    // Second backoff step (cap 2 s, half jitter) fires at 1 s; a reset count would fire at 500 ms.
    await vi.advanceTimersByTimeAsync(980)
    expect(fakes.assign.mock.calls.length).toBe(assignsBefore + 1)
    await vi.advanceTimersByTimeAsync(30)
    expect(fakes.assign.mock.calls.length).toBe(assignsBefore + 2)
    pool.closeNow()
  })

  it('skips the fresh-generation hello when the director-named cell refuses the resume', async () => {
    fakes.assign.mockReset().mockResolvedValue(assignment(CELL, 3))
    fakes.controlConnect
      .mockResolvedValueOnce(ACK)
      .mockRejectedValueOnce(new RelayControlClosedError(4409, null))
    const pool = await openPool()

    fakes.controls[0]!.options.onDrain(DRAIN)
    await vi.advanceTimersByTimeAsync(0)

    expect(fakes.controls).toHaveLength(2)
    expect(fakes.controls[1]!.options.controlResumeSecret).toBe('R'.repeat(43))
    pool.closeNow()
  })

  it('cancels the lease rotation when the control is lost', async () => {
    fakes.controlConnect.mockResolvedValue({ ...ACK, leaseExpiresAt: 200_000 })
    const pool = await openPool()

    fakes.controls[0]!.options.onClose(4503)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(fakes.controls).toHaveLength(1)
    pool.closeNow()
  })

  it('recovers at once when the reattached control drops before its resolution settles', async () => {
    let dropOnRegister = false
    const onStatus = vi.fn((status: string) => {
      if (status === 'registered' && dropOnRegister) {
        dropOnRegister = false
        fakes.controls[1]!.options.onClose(1006)
      }
    })
    const pool = await openPool(onStatus)
    dropOnRegister = true

    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.controls).toHaveLength(2)

    // Immediate director call, not the backoff's 500 ms.
    expect(fakes.assign).toHaveBeenCalledTimes(2)
    pool.closeNow()
  })

  it('does no work after the pool closes during the reattach wait', async () => {
    const pool = await openPool()
    fakes.controls[0]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(fakes.controls).toHaveLength(2)

    fakes.controls[1]!.options.onClose(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    pool.closeNow()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fakes.controls).toHaveLength(2)
  })
})
