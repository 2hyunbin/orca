import { describe, expect, it, vi } from 'vitest'
import {
  CELL_POLL_DEAD_MAX_GAP_MS,
  CELL_POLL_DEAD_STREAK_MS,
  CellPollReachability
} from './cell-poll-reachability.js'
import { startShadowSeatPoller, type SeatFeedCell } from './shadow-seat-directory.js'

// Fails `cellId` once a second from `from` for `ms`, as the 1 s poller does.
function failFor(reach: CellPollReachability, cellId: string, from: number, ms: number): number {
  let at = from
  for (; at <= from + ms; at += 1_000) reach.unanswered(cellId, at)
  return at - 1_000
}

describe('CellPollReachability', () => {
  it('calls a cell dead only after a continuous failing streak of 45 s', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'c2', 0, CELL_POLL_DEAD_STREAK_MS - 1_000)
    expect(reach.dead('c2', 3, last)).toBe(false)
    reach.unanswered('c2', last + 1_000)
    expect(reach.dead('c2', 3, last + 1_000)).toBe(true)
  })

  it('needs a failure within the last 5 s: a frozen director has no verdict until it polls again', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'c2', 0, CELL_POLL_DEAD_STREAK_MS)
    expect(reach.dead('c2', 3, last)).toBe(true)
    // The director froze: nothing was asked, so nothing is known.
    expect(reach.dead('c2', 3, last + CELL_POLL_DEAD_MAX_GAP_MS + 1)).toBe(false)
    // After the freeze a single failure starts a new streak rather than resuming the old one.
    reach.unanswered('c2', last + 60_000)
    expect(reach.dead('c2', 3, last + 60_000)).toBe(false)
  })

  it('resets on any answer from the cell', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'c2', 0, CELL_POLL_DEAD_STREAK_MS)
    reach.answered('c2')
    reach.unanswered('c2', last + 1_000)
    expect(reach.dead('c2', 3, last + 1_000)).toBe(false)
  })

  it('gives no verdict when more than a third of the polled cells fail at once', () => {
    const reach = new CellPollReachability()
    failFor(reach, 'c1', 0, CELL_POLL_DEAD_STREAK_MS)
    const last = failFor(reach, 'c2', 0, CELL_POLL_DEAD_STREAK_MS)
    // Two of six is a third: still the cells.
    expect(reach.dead('c2', 6, last)).toBe(true)
    // Two of five is more than a third: this director's network or credential.
    expect(reach.dead('c2', 5, last)).toBe(false)
    // One of three is the staging shape (c1, c2, c4) and qualifies.
    expect(reach.dead('c1', 3, last)).toBe(false)
    reach.answered('c1')
    expect(reach.dead('c2', 3, last)).toBe(true)
  })

  it('forgets cells no longer listed', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'c2', 0, CELL_POLL_DEAD_STREAK_MS)
    reach.forget(new Set(['c1']))
    expect(reach.dead('c2', 3, last)).toBe(false)
  })
})

const CELLS: SeatFeedCell[] = ['c1', 'c2', 'c4'].map((cellId) => ({
  cellId,
  cellUrl: `https://${cellId}.example.test`,
  region: 'us-central1',
  heartbeatExpiresAt: 2_000_000_000_000,
  requiredForComplete: true
}))

function poller(respond: (cellId: string) => Response | Promise<Response>, identityFails = false) {
  let now = 1_000
  const started = startShadowSeatPoller(
    { role: 'director', rehomeAudience: 'https://relay.example.test/rehome', shadowSeatFeedCells: 'all' },
    {
      listCells: async () => CELLS,
      fetch: vi.fn(async (input: string | URL | Request) =>
        await respond(new URL(String(input)).hostname.split('.')[0] ?? '')
      ),
      identityToken: vi.fn(async () => {
        if (identityFails) throw new Error('metadata_unavailable')
        return 'token-1'
      }),
      now: () => now,
      pollMs: 3_600_000,
      log: () => undefined
    }
  )
  if (!started) throw new Error('poller not started')
  return {
    ...started,
    // One poll a second for `ms`.
    run: async (ms: number) => {
      for (let elapsed = 0; elapsed <= ms; elapsed += 1_000) {
        await started.tick()
        now += 1_000
      }
      now -= 1_000
      return now
    }
  }
}

const answer = (status: number) => new Response('{}', { status })

describe('seat-feed poller reachability', () => {
  it('counts timeouts, connection failures and load-balancer 502/503/504 as unanswered', async () => {
    for (const fail of [
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      () => answer(502),
      () => answer(503),
      () => answer(504)
    ]) {
      const cells = poller((cellId) => (cellId === 'c2' ? fail() : answer(404)))
      const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
      cells.stop()
      expect(cells.pollsDead('c2', at)).toBe(true)
      expect(cells.pollsDead('c1', at)).toBe(false)
    }
  })

  it('treats any status the cell itself sends as alive: 401, 404, 500', async () => {
    for (const status of [401, 404, 500]) {
      const cells = poller((cellId) => (cellId === 'c2' ? answer(status) : answer(404)))
      const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
      cells.stop()
      expect(cells.pollsDead('c2', at)).toBe(false)
    }
  })

  it('does not blame a cell for a token this director cannot mint', async () => {
    const cells = poller(() => answer(404), true)
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.pollsDead('c2', at)).toBe(false)
  })
})
