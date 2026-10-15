import type { OrchestrationDb } from '../orchestration-db'

/** The turn each hand-off reached (JSON, delivery-holder-store.ts), and the two re-offer budgets.
 *  Null on every column: no reference, as on every row before v44. */
const HAND_OFF_COLUMNS = [
  ['deliveries', 'holder', 'TEXT'],
  ['messages', 'pointed_by', 'TEXT'],
  ['messages', 'reoffered_by_runtime', 'TEXT'],
  ['messages', 'reoffered_after_cut', 'INTEGER']
] as const

/**
 * A hand-off records the turn it reached, so a reader whose turn was cut (Orca quit, the provider
 * or the agent process died) can be told apart from one that has the mail. See `delivery-holder.ts`.
 * Guarded because createTables runs first on every open and already gives a fresh database these.
 */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current < 44) {
    addHandOffColumns(this)
  }
}

/** A database a development build stamped 44 with earlier holder columns gains these in place;
 *  the columns it has left over are never read. */
export function repairV44HandOffColumns(this: OrchestrationDb, storedVersion: number): void {
  if (storedVersion === 44) {
    addHandOffColumns(this)
  }
}

function addHandOffColumns(db: OrchestrationDb): void {
  for (const [table, column, type] of HAND_OFF_COLUMNS) {
    if (!db.hasColumn(table, column)) {
      db.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
}
