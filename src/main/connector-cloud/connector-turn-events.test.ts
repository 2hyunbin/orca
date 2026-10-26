import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ConnectorEvent } from '../../shared/connector-cloud-contract'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorTurnEvents } from './connector-turn-events'

const conversation = { source: 'slack', externalId: 'T1:C9:1' } as const
const REFUSED: ConnectorFailure = { ok: false, status: 503, error: null, retryAfterMs: null }
let userDataPath: string

const prompt = (promptId: string) =>
  ({
    kind: 'prompt',
    conversation,
    worktreeId: 'wt',
    paneKey: 'tab:1',
    prompt: { kind: 'unsupported', promptId }
  }) as const
const turnEnded = (turnId: number) =>
  ({
    kind: 'turn-ended',
    conversation,
    worktreeId: 'wt',
    paneKey: 'tab:1',
    turnId,
    stopReason: null,
    at: turnId
  }) as const

beforeEach(() => {
  vi.useFakeTimers()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-events-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorTurnEvents', () => {
  it('never drops a new hello’s snapshot, even behind a request still in flight', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    const held = Promise.withResolvers<ConnectorFailure | null>()
    const sent: [number, ConnectorEvent[]][] = []
    let first = true
    events.attach(async (batch, seq) => {
      sent.push([seq, batch])
      if (first) {
        first = false
        return held.promise
      }
      return null
    })
    events.observe(prompt('old'))
    events.observe({ kind: 'snapshot', conversations: [] })
    for (let index = 0; index < 600; index++) {
      events.observe(prompt(String(index)))
    }
    held.resolve(REFUSED)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent[1]?.[0]).toBe(0)
    expect(sent[1]?.[1][0]).toEqual({ kind: 'snapshot', conversations: [] })
  })

  it('keeps 200 turn ends in all, counting a refused batch that holds some', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    for (let turn = 1; turn <= 50; turn++) {
      events.observe(turnEnded(turn))
    }
    // The first send freezes all 50 into one refused batch.
    events.attach(async () => REFUSED)
    await vi.advanceTimersByTimeAsync(0)
    for (let turn = 51; turn <= 300; turn++) {
      events.observe(turnEnded(turn))
    }
    const { account, turnEnds: stored } = z
      .object({ account: z.string(), turnEnds: z.array(z.unknown()) })
      .parse(JSON.parse(readFileSync(join(userDataPath, 'connector-turn-outbox.json'), 'utf8')))
    expect(account).toBe('ada')
    expect(stored).toHaveLength(200)
    expect(stored[0]).toMatchObject({ turnId: 1 })
    expect(stored.at(-1)).toMatchObject({ turnId: 300 })
  })

  it('asks for a snapshot once the caps drop an event, until the next snapshot arrives', () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    for (let index = 0; index < 500; index++) {
      events.observe(prompt(String(index)))
    }
    expect(events.needsSnapshot).toBe(false)
    events.observe(prompt('one too many'))
    expect(events.needsSnapshot).toBe(true)
    events.observe({ kind: 'snapshot', conversations: [] })
    expect(events.needsSnapshot).toBe(false)
  })

  it('restores only the turn ends its own account left on disk', async () => {
    const first = new ConnectorTurnEvents(userDataPath, 'ada')
    first.observe(turnEnded(1))
    const sent: ConnectorEvent[][] = []
    const other = new ConnectorTurnEvents(userDataPath, 'grace')
    other.attach(async (batch) => {
      sent.push(batch)
      return null
    })
    const again = new ConnectorTurnEvents(userDataPath, 'ada')
    again.attach(async (batch) => {
      sent.push(batch)
      return REFUSED
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([[expect.objectContaining({ kind: 'turn-ended', turnId: 1 })]])
  })
})
