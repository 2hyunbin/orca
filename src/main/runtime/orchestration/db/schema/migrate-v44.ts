import type { OrchestrationDb } from '../orchestration-db'

/** Who holds a fetched batch (`check`): a structured session's turn, or a terminal agent's turn in
 *  its PTY. Null on every column: no holder, as on every row before v44. */
const DELIVERY_HOLDER_COLUMNS = [
  ['deliveries', 'holder_session_id', 'TEXT'],
  ['deliveries', 'holder_turn_item_id', 'TEXT'],
  ['deliveries', 'holder_pane_key', 'TEXT'],
  ['deliveries', 'holder_process_incarnation', 'TEXT'],
  ['deliveries', 'holder_agent_session_id', 'TEXT'],
  ['deliveries', 'holder_agent_turn_started_at', 'INTEGER'],
  // A message's two re-offer budgets: once per Orca launch after a restart, once in all otherwise.
  ['messages', 'reoffered_by_runtime', 'TEXT'],
  ['messages', 'reoffered_after_cut', 'INTEGER']
] as const

/**
 * A batch handed to a reader records who holds it, so a reader whose turn was cut (Orca quit, the
 * provider died) can be told apart from one that has the mail in hand. See `delivery-holder.ts`.
 */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database these.
  for (const [table, column, type] of DELIVERY_HOLDER_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
}
