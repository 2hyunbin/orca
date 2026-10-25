import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimDeadManTripSlot } from './cell-dead-man-trip-slot.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

// Concurrent claims on real PostgreSQL: a director outage trips at most `slots` cells, however
// many claim at the same moment.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const run = randomUUID().slice(0, 8)
const cells = Array.from({ length: 8 }, (_, index) => `slots-pg-${index}-${run}`)
const TABLES = ['relay_cell_admit_effective', 'relay_cell_admit_modes', 'relay_cell_runtime']

describePostgres('dead-man trip slots on PostgreSQL', () => {
  let database: RelayDatabase
  const now = Date.now()

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp', poolMax: cells.length })
    for (const cellId of cells) {
      await database.query(`INSERT INTO relay_cell_admit_modes (cell_id, admit_mode, updated_at) VALUES (?, 'reserve', ?)`, [cellId, now])
      await database.query(
        `INSERT INTO relay_cell_runtime
         (cell_id, cell_url, cell_incarnation, started_at, ready, observed_requests, last_heartbeat_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
        [cellId, `https://${cellId}.example.com`, `inc-${cellId}`, now, now, now]
      )
    }
  })

  afterAll(async () => {
    for (const table of TABLES) {
      for (const cellId of cells) await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cellId])
    }
    await database.close()
  })

  const claim = async (cellId: string, slots: number) =>
    await claimDeadManTripSlot(database, {
      cellId,
      cellIncarnation: `inc-${cellId}`,
      slots,
      now,
      heartbeatTtlMs: 45_000
    })

  it('grants exactly the free slots to cells that claim together, and frees one when its holder stops heartbeating', async () => {
    const granted = await Promise.all(cells.map(async (cellId) => await claim(cellId, 2)))
    expect(granted.filter(Boolean)).toHaveLength(2)
    const rows = await database.query(
      `SELECT cell_id FROM relay_cell_admit_effective WHERE mode = 'db' AND cell_id LIKE ?`,
      [`slots-pg-%-${run}`]
    )
    expect(rows).toHaveLength(2)
    // A holder that re-claims keeps its own slot: it never counts itself.
    const holder = cells[granted.indexOf(true)]!
    expect(await claim(holder, 2)).toBe(true)

    await database.query(`UPDATE relay_cell_runtime SET last_heartbeat_at = ? WHERE cell_id = ?`, [now - 60_000, holder])
    const waiting = cells.filter((_, index) => !granted[index])
    const second = await Promise.all(waiting.map(async (cellId) => await claim(cellId, 2)))
    expect(second.filter(Boolean)).toHaveLength(1)
  })
})
