import { describe, expect, it, vi } from 'vitest'
import {
  CELL_POLL_DEAD_MAX_GAP_MS,
  CELL_POLL_DEAD_STREAK_MS,
  CELL_POLL_DEAD_MIN_POLLED,
  CellPollReachability,
  type PolledCell
} from './cell-poll-reachability.js'
import { startShadowSeatPoller, type SeatFeedCell } from './shadow-seat-directory.js'

// Fails `cellId` once a second from `from` for `ms`, as the 1 s poller does.
function failFor(reach: CellPollReachability, cellId: string, from: number, ms: number): number {
  let at = from
  for (; at <= from + ms; at += 1_000) reach.unanswered(cellId, at)
  return at - 1_000
}

// Production's shape: 28 US cells and 6 in Asia.
const FLEET: PolledCell[] = [
  ...Array.from({ length: 28 }, (_, index) => ({ cellId: `us${index}`, region: 'us-central1' })),
  ...Array.from({ length: 6 }, (_, index) => ({ cellId: `asia${index}`, region: 'asia-east2' }))
]

describe('CellPollReachability', () => {
  it('calls a cell dead only after a continuous failing streak of 45 s', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'us1', 0, CELL_POLL_DEAD_STREAK_MS - 1_000)
    expect(reach.verdict('us1', FLEET, last)).toBeNull()
    reach.unanswered('us1', last + 1_000)
    expect(reach.verdict('us1', FLEET, last + 1_000)).toEqual({
      dead: true,
      fleetUnreachable: 1,
      fleetPolled: 34,
      regionUnreachable: 1,
      regionPolled: 28
    })
  })

  it('needs a failure within the last 5 s: a frozen director has no verdict until it polls again', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'us1', 0, CELL_POLL_DEAD_STREAK_MS)
    expect(reach.verdict('us1', FLEET, last)?.dead).toBe(true)
    // The director froze: nothing was asked, so nothing is known.
    expect(reach.verdict('us1', FLEET, last + CELL_POLL_DEAD_MAX_GAP_MS + 1)).toBeNull()
    // After the freeze a single failure starts a new streak rather than resuming the old one.
    reach.unanswered('us1', last + 60_000)
    expect(reach.verdict('us1', FLEET, last + 60_000)).toBeNull()
  })

  it('resets on any answer from the cell', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'us1', 0, CELL_POLL_DEAD_STREAK_MS)
    reach.answered('us1')
    reach.unanswered('us1', last + 1_000)
    expect(reach.verdict('us1', FLEET, last + 1_000)).toBeNull()
  })

  it(`never decides from fewer than ${CELL_POLL_DEAD_MIN_POLLED} polled cells`, () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'us1', 0, CELL_POLL_DEAD_STREAK_MS)
    const five = FLEET.slice(0, 5)
    expect(reach.verdict('us1', five, last)).toMatchObject({ dead: false, withheld: 'sample' })
    expect(reach.verdict('us1', FLEET.slice(0, 6), last)?.dead).toBe(true)
  })

  it('withholds when more than a third of the fleet fails at once: this director, not the cells', () => {
    const reach = new CellPollReachability()
    let last = 0
    // 12 US cells: 12 of 34 is more than a third; 12 of 28 in the region is under half.
    for (let index = 0; index < 12; index += 1) last = failFor(reach, `us${index}`, 0, CELL_POLL_DEAD_STREAK_MS)
    expect(reach.verdict('us1', FLEET, last)).toMatchObject({ dead: false, withheld: 'fleet', fleetUnreachable: 12 })
    reach.answered('us11')
    expect(reach.verdict('us1', FLEET, last)?.dead).toBe(true)
  })

  it('withholds when half or more of the cell\'s region fails: a cross-region partition', () => {
    const reach = new CellPollReachability()
    let last = 0
    // Every Asia cell: 6 of 34 passes the fleet guard; the region guard catches it.
    for (let index = 0; index < 6; index += 1) last = failFor(reach, `asia${index}`, 0, CELL_POLL_DEAD_STREAK_MS)
    expect(reach.verdict('asia0', FLEET, last)).toEqual({
      dead: false,
      withheld: 'region',
      fleetUnreachable: 6,
      fleetPolled: 34,
      regionUnreachable: 6,
      regionPolled: 6
    })
    // Half the region is still a partition.
    for (const cellId of ['asia3', 'asia4', 'asia5']) reach.answered(cellId)
    expect(reach.verdict('asia0', FLEET, last)?.withheld).toBe('region')
    // A zone loss (2 of 6) is cells.
    reach.answered('asia2')
    expect(reach.verdict('asia0', FLEET, last)).toMatchObject({ dead: true, regionUnreachable: 2, regionPolled: 6 })
  })

  it('forgets cells no longer listed', () => {
    const reach = new CellPollReachability()
    const last = failFor(reach, 'us1', 0, CELL_POLL_DEAD_STREAK_MS)
    reach.forget(new Set(['us2']))
    expect(reach.verdict('us1', FLEET, last)).toBeNull()
  })
})

const CELLS: SeatFeedCell[] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((cellId) => ({
  cellId,
  cellUrl: `https://${cellId}.example.test`,
  region: 'us-central1',
  heartbeatExpiresAt: 2_000_000_000_000,
  requiredForComplete: true
}))

function poller(respond: (cellId: string) => Response | Promise<Response>, identityFails = false) {
  let now = 1_000
  const logs: string[] = []
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
      log: (line) => logs.push(line)
    }
  )
  if (!started) throw new Error('poller not started')
  return {
    ...started,
    logs,
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
      expect(cells.deadCellVerdict('c2', at)?.dead).toBe(true)
      expect(cells.deadCellVerdict('c1', at)).toBeNull()
    }
  })

  it('treats any status the cell itself sends as alive: 401, 404, 500', async () => {
    for (const status of [401, 404, 500]) {
      const cells = poller((cellId) => (cellId === 'c2' ? answer(status) : answer(404)))
      const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
      cells.stop()
      expect(cells.deadCellVerdict('c2', at)).toBeNull()
    }
  })

  it('does not blame a cell for a token this director cannot mint', async () => {
    const cells = poller(() => answer(404), true)
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('c2', at)).toBeNull()
  })

  it('logs a withheld verdict once a minute per cell, for the alert', async () => {
    const down = new Set(['c1', 'c2', 'c3'])
    const cells = poller((cellId) => (down.has(cellId) ? answer(502) : answer(404)))
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('c2', at)).toMatchObject({ dead: false, withheld: 'fleet' })
    cells.deadCellVerdict('c2', at + 1_000)
    const withheld = cells.logs.filter((line) => line.includes('orca_relay_dead_cell_verdict_withheld'))
    expect(withheld).toHaveLength(1)
    expect(JSON.parse(withheld[0]!)).toMatchObject({ cellId: 'c2', withheld: 'fleet', fleetUnreachable: 3, fleetPolled: 6 })
  })
})
