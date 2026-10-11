import { CONTROL_CONTINUITY_LIMITS, RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerProof,
  hostControlProofFixture,
  openProof,
  ProofSocket
} from './test-fixtures/host-control-proof.js'

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-11T13:20:00Z') }))
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

function sentAck(socket: ProofSocket): { generation: number; controlResumeSecret: string } {
  const frame: unknown = JSON.parse(socket.send.mock.calls[1]?.[0] ?? 'null')
  if (
    frame === null ||
    typeof frame !== 'object' ||
    !('type' in frame) ||
    frame.type !== 'host-hello-ack' ||
    !('generation' in frame) ||
    typeof frame.generation !== 'number' ||
    !('controlResumeSecret' in frame) ||
    typeof frame.controlResumeSecret !== 'string'
  ) {
    throw new Error('missing host hello ack')
  }
  return { generation: frame.generation, controlResumeSecret: frame.controlResumeSecret }
}

// A host whose token lapsed while auth was down: the cell expires its control at the next
// heartbeat, and the host comes back inside orphan grace with a resume secret and a new token.
async function lapsedHost() {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const h = hostControlProofFixture()
  vi.spyOn(h.assignments, 'renewControlActivities').mockImplementation(async (rows) =>
    rows.map(() => 'renewed')
  )
  const lapsed = { ...h.identity, exp: nowSeconds() - 61 }
  const first = await openProof(h, new ProofSocket(), lapsed)
  answerProof(first, h.keyPair)
  await vi.advanceTimersByTimeAsync(0)
  const ack = sentAck(first)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(first.close).toHaveBeenCalledWith(
    RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
    'relay authorization expired'
  )
  const session = h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })
  expect(session?.state).toBe('orphaned')
  expect(CONTROL_CONTINUITY_LIMITS.orphanGraceMs).toBeGreaterThan(5_000)
  await vi.advanceTimersByTimeAsync(5_000)
  const resumeHello = (overrides: object = {}) =>
    JSON.stringify({
      ...JSON.parse(h.hello),
      previousGeneration: ack.generation,
      controlResumeSecret: ack.controlResumeSecret,
      ...overrides
    })
  return { h, ack, session: session!, resumeHello }
}

describe('a resumed control adopts the token its hello proved', () => {
  it('keeps the resumed control past the heartbeat that expired its predecessor', async () => {
    const { h, ack, session, resumeHello } = await lapsedHost()
    const fresh = { ...h.identity, exp: nowSeconds() + 300 }
    const resumed = await openProof(h, new ProofSocket(), fresh, resumeHello())
    answerProof(resumed, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(sentAck(resumed).generation).toBe(ack.generation)
    expect(h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })).toBe(
      session
    )
    expect(session.identity.exp).toBe(fresh.exp)
    expect(session.state).toBe('active')
    // Several heartbeats; before the fix the first one closed it 4401 and the host looped.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resumed.close).not.toHaveBeenCalled()
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('keeps a later expiry a refresh delivered over an older token the hello carried', async () => {
    const { h, session, resumeHello } = await lapsedHost()
    session.identity = { ...session.identity, exp: nowSeconds() + 600 }
    const older = { ...h.identity, exp: nowSeconds() + 120 }
    const resumed = await openProof(h, new ProofSocket(), older, resumeHello())
    answerProof(resumed, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.identity.exp).toBe(nowSeconds() + 600)
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('starts a new generation when the hello speaks for another profile', async () => {
    const { h, ack, session, resumeHello } = await lapsedHost()
    const otherProfile = { ...h.identity, prof: 'profile-other', exp: nowSeconds() + 300 }
    const replacement = await openProof(h, new ProofSocket(), otherProfile, resumeHello())
    answerProof(replacement, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(sentAck(replacement).generation).toBe(ack.generation + 1)
    expect(session.state).toBe('closed')
    const current = h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })
    expect(current?.identity.prof).toBe('profile-other')
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
  })
})
