import { RELAY_ADMISSION_BUDGETS } from '@orca-cloud/relay-contract'
import type { RelayCellConfig } from './config.js'
import type { RelayDatabase, SqlRow } from './database.js'

// The one owner of relay_cell_connection_limits.hard_cap. The director's configured cap and the
// cap the cell last reported enforcing can differ while a cell is being resized; placement must
// never count seats a running process does not have, so every capacity reader takes the lower.
// A NULL report (a row no heartbeat has stamped yet) compares unknown and falls to the ELSE arm.
export const EFFECTIVE_HARD_CAP_SQL = `(CASE WHEN limits.reported_hard_cap < limits.hard_cap
  THEN limits.reported_hard_cap ELSE limits.hard_cap END)`

// Column list for readers that report the cap; requires the table aliased as `limits`.
export const CONNECTION_CAP_COLUMNS_SQL = `limits.hard_cap AS configured_hard_cap,
  limits.reported_hard_cap, ${EFFECTIVE_HARD_CAP_SQL} AS effective_hard_cap,
  limits.unobserved_bound`

export type CellConnectionCap = {
  // Configured on the director; old scripts read this field, so its meaning is fixed.
  hardCap: number
  reportedHardCap: number | null
  effectiveHardCap: number
  controlRebindReserve: number
  ordinaryConnectionLimit: number
  unobservedBound: number
  normalAdmissionPause: number
}

// Derived limits follow the effective cap: a same-cap job counting free slots from them must not
// count a raise the cell has not taken yet.
export function readCellConnectionCap(row: SqlRow): CellConnectionCap {
  const effectiveHardCap = capInteger(row, 'effective_hard_cap')
  const unobservedBound = capInteger(row, 'unobserved_bound')
  const ordinaryConnectionLimit = effectiveHardCap - RELAY_ADMISSION_BUDGETS.reservedHostControls
  return {
    hardCap: capInteger(row, 'configured_hard_cap'),
    reportedHardCap:
      row.reported_hard_cap === null || row.reported_hard_cap === undefined
        ? null
        : capInteger(row, 'reported_hard_cap'),
    effectiveHardCap,
    controlRebindReserve: RELAY_ADMISSION_BUDGETS.reservedHostControls,
    ordinaryConnectionLimit,
    unobservedBound,
    normalAdmissionPause: ordinaryConnectionLimit - unobservedBound
  }
}

// A cell may run below the configured cap (it has not been rolled onto a raise yet), never above
// it, and its unobserved allowance is part of the placement ceiling so it must match exactly.
// Returns the cap to record, or undefined when the report does not fit.
export function reportedHardCapWithinLimit(
  limit: SqlRow,
  report: { connectionHardCap?: number; connectionUnobservedBound?: number }
): number | undefined {
  if (
    report.connectionHardCap === undefined ||
    report.connectionHardCap > capInteger(limit, 'hard_cap') ||
    report.connectionUnobservedBound !== capInteger(limit, 'unobserved_bound')
  ) {
    return undefined
  }
  return report.connectionHardCap
}

// The caller holds the limits row locked (the heartbeat's own row read), so this cannot race a
// configuration write. Written only on change: steady heartbeats leave the row untouched.
export async function recordReportedHardCap(
  transaction: RelayDatabase,
  cellId: string,
  reportedHardCap: number
): Promise<void> {
  await transaction.query(
    `UPDATE relay_cell_connection_limits SET reported_hard_cap = ?
     WHERE cell_id = ? AND (reported_hard_cap IS NULL OR reported_hard_cap <> ?)`,
    [reportedHardCap, cellId, reportedHardCap]
  )
}

// A raise (same unobserved bound, higher cap) changes nothing placement reads: the cap the cell
// last reported, or failing a report the cap it was configured with until now, is recorded as its
// report, so the effective cap stays put until the cell itself reports the higher one. That is
// also why its telemetry rows survive. Any other change keeps the old fail-closed reset.
export async function writeCellConnectionLimit(
  transaction: RelayDatabase,
  cell: Pick<RelayCellConfig, 'id' | 'connectionHardCap' | 'connectionUnobservedBound'>,
  now: number
): Promise<void> {
  const { connectionHardCap, connectionUnobservedBound } = cell
  // An uncapped config leaves any existing row alone, as before.
  if (connectionHardCap === undefined || connectionUnobservedBound === undefined) return
  const current = (
    await transaction.queryLocked(
      `SELECT limits.hard_cap, limits.unobserved_bound,
         ${EFFECTIVE_HARD_CAP_SQL} AS effective_hard_cap
       FROM relay_cell_connection_limits limits WHERE limits.cell_id = ?`,
      [cell.id]
    )
  )[0]
  const changed =
    current !== undefined &&
    (capInteger(current, 'hard_cap') !== connectionHardCap ||
      capInteger(current, 'unobserved_bound') !== connectionUnobservedBound)
  const raised =
    changed &&
    capInteger(current, 'unobserved_bound') === connectionUnobservedBound &&
    connectionHardCap > capInteger(current, 'hard_cap')
  if (raised) {
    await transaction.query(
      `UPDATE relay_cell_connection_limits
       SET hard_cap = ?, reported_hard_cap = ?, updated_at = ?
       WHERE cell_id = ?`,
      [connectionHardCap, capInteger(current, 'effective_hard_cap'), now, cell.id]
    )
    return
  }
  await transaction.query(
    `INSERT INTO relay_cell_connection_limits
     (cell_id, hard_cap, unobserved_bound, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (cell_id) DO UPDATE SET
       hard_cap = excluded.hard_cap,
       unobserved_bound = excluded.unobserved_bound,
       updated_at = excluded.updated_at`,
    [cell.id, connectionHardCap, connectionUnobservedBound, now]
  )
  if (changed) {
    await transaction.query(`DELETE FROM relay_cell_connection_snapshots WHERE cell_id = ?`, [
      cell.id
    ])
    await transaction.query(`DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`, [
      cell.id
    ])
  }
}

function capInteger(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new Error(`invalid_${field}`)
  return value
}
