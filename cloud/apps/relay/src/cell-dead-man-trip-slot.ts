import { commitWithFinalWrite, type RelayDatabase } from './database.js'

// A reserve cell's dead-man may trip only while fewer than `slots` other reserve cells are
// tripped, so a director outage moves a bounded number of cells onto their full database pools.
// A slot is held while the cell's own row says db, its switch (relay_cell_admit_modes) still
// says reserve, and its current process heartbeats: a crashed or re-armed cell frees it.
export async function claimDeadManTripSlot(
  database: RelayDatabase,
  input: {
    cellId: string
    cellIncarnation: string
    slots: number
    now: number
    heartbeatTtlMs: number
  }
): Promise<boolean> {
  return await database.transaction(async (transaction) => {
    // SQLite transactions already run one at a time; on PostgreSQL concurrent claims would
    // each count the others' uncommitted rows as free.
    if (transaction.dialect === 'postgres') {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtext('orca-relay'), hashtext('dead-man-trip-slots'))`
      )
    }
    return await commitWithFinalWrite(
      transaction,
      `INSERT INTO relay_cell_admit_effective (cell_id, cell_incarnation, mode, updated_at)
       SELECT ?, ?, 'db', ?
       WHERE (
         SELECT count(*) FROM relay_cell_admit_effective e
         JOIN relay_cell_admit_modes m ON m.cell_id = e.cell_id AND m.admit_mode = 'reserve'
         JOIN relay_cell_runtime r
           ON r.cell_id = e.cell_id AND r.cell_incarnation = e.cell_incarnation
         WHERE e.mode = 'db' AND e.cell_id <> ? AND r.last_heartbeat_at > ?
       ) < ?
       ON CONFLICT (cell_id) DO UPDATE SET
         cell_incarnation = excluded.cell_incarnation,
         mode = excluded.mode,
         updated_at = excluded.updated_at
       RETURNING cell_id`,
      [
        input.cellId,
        input.cellIncarnation,
        input.now,
        input.cellId,
        input.now - input.heartbeatTtlMs,
        input.slots
      ]
    )
  })
}
