import type { RelayRegion } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { CellReserveClient } from './cell-reserve-client.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { ReserveAssignment } from './reserve-assignment.js'
import { ReservePlacer } from './reserve-placement.js'
import { ShadowSeatDirectory, type SeatFeedCell } from './shadow-seat-directory.js'

// A fleet with no database-mode cell: the real plan and the real store, with each reserve
// cell's own booking rule played by a ceiling of two seats.

const CEILING = 2
const CELLS: RelayCellConfig[] = [
  { id: 'us-r', url: 'https://us-r.example.com', region: 'us-central1', capacityRequests: 100 },
  { id: 'asia-r', url: 'https://asia-r.example.com', region: 'asia-east2', capacityRequests: 100 }
]

describe('an all-reserve two-region fleet', () => {
  let database: RelayDatabase
  let store: RelayAssignmentStore
  let reserve: ReserveAssignment
  let now = 100_000
  const booked = new Map<string, number>()

  beforeEach(async () => {
    now = 100_000
    booked.clear()
    database = await openInMemoryRelayDatabase()
    store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells(CELLS)
    for (const cell of CELLS) await store.setCellAdmitMode(cell.id, 'reserve')
    const feedCells: SeatFeedCell[] = CELLS.map((cell) => ({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region as RelayRegion,
      heartbeatExpiresAt: Number.MAX_SAFE_INTEGER,
      requiredForComplete: true,
      general: true
    }))
    const directory = new ShadowSeatDirectory()
    directory.setCells(CELLS.map((cell) => cell.id))
    for (const cell of CELLS) {
      directory.apply(
        cell.id,
        {
          v: 1,
          cellId: cell.id,
          incarnation: `${cell.id}-1`,
          seq: 1,
          at: 0,
          counts: { seats: 0, controls: 0, bookings: 0, units: 0, ceiling: CEILING },
          intake: { perSec: 100, burst: 20, tokens: 20 },
          flagsApplied: { generation: 1, flags: { admitMode: 'reserve' } },
          full: []
        },
        now - 1_000,
        now
      )
    }
    const client = {
      reserve: async (target: { cellId: string }) => {
        const count = booked.get(target.cellId) ?? 0
        if (count >= CEILING) return { outcome: 'full' }
        booked.set(target.cellId, count + 1)
        return { outcome: 'ok' }
      },
      demote: async () => 'demoted'
    } satisfies Pick<CellReserveClient, 'reserve' | 'demote'>
    const placer = new ReservePlacer(() => now, () => 0.25)
    reserve = new ReserveAssignment({
      mode: 'on',
      directory,
      cells: () => feedCells,
      startedAt: 0,
      placer,
      // SAFETY: only reserve and demote are called, and both are implemented above.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
      client: client as unknown as CellReserveClient,
      readRow: async () => null,
      now: () => now,
      random: () => 0.25,
      log: () => undefined
    })
    // A director's estimate starts empty; the first look starts the refill clock.
    for (const cell of reserve.placementCells()) placer.hasBudget(cell)
    now += 1_000
  })

  afterEach(async () => await database.close())

  // What /v1/assign does with a fresh host's plan.
  const assignFresh = async (host: number, region: RelayRegion) => {
    const identity = { userId: 'user-1', relayHostId: `fleethost${String(host).padStart(7, '0')}` }
    const plan = await reserve.plan(identity, { reconnect: false, region })
    if (plan.kind === 'answer') return plan.assignment
    if (plan.kind === 'retry') throw new Error(`retry:${plan.reason}`)
    return await store.assign(identity, region, region, undefined, { ...plan, hostRequested: true })
  }

  it('seats US hosts on the Asia reserve cell once US is full, then refuses', async () => {
    const regions: Array<string | undefined> = []
    for (let host = 0; host < 2 * CEILING; host++) {
      regions.push((await assignFresh(host, 'us-central1')).region)
    }
    expect(regions).toEqual(['us-central1', 'us-central1', 'asia-east2', 'asia-east2'])
    await expect(assignFresh(2 * CEILING, 'us-central1')).rejects.toThrow('relay_capacity_exhausted')
    expect(await database.query(`SELECT cell_id FROM relay_assignments`)).toEqual([])
  })
})
