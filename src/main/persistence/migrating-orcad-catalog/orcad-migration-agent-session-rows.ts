/**
 * One session's rows in the chat journal tables the `agent-session-records` blob carries: read on
 * the source to build the document, read on the destination to tell an installed session from a
 * conflicting one, and inserted there by the installer.
 */
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import {
  ORCAD_MIGRATION_AGENT_SESSION_TABLE_NAMES,
  ORCAD_MIGRATION_AGENT_SESSION_TABLES,
  orcadMigrationAgentSessionColumns,
  type OrcadMigrationAgentSessionCell,
  type OrcadMigrationAgentSessionRow,
  type OrcadMigrationAgentSessionTable,
  type OrcadMigrationAgentSessionTableRows
} from './orcad-migration-agent-session-format'

/** Every carried table's rows for `sessionId`, in the document's order; a missing table reads empty. */
export function readOrcadMigrationAgentSessionTableRows(
  db: Database.Database,
  sessionId: string
): OrcadMigrationAgentSessionTableRows {
  const present = existingTables(db)
  const read = (table: OrcadMigrationAgentSessionTable): OrcadMigrationAgentSessionRow[] => {
    if (!present.has(table)) {
      return []
    }
    const columns = orcadMigrationAgentSessionColumns(table)
    return db
      .prepare(
        `SELECT ${columns.join(', ')} FROM ${table} WHERE session_id = ? ORDER BY ${ORCAD_MIGRATION_AGENT_SESSION_TABLES[table].orderBy}`
      )
      .all(sessionId)
      .map((row) => cells(table, columns, row))
  }
  return {
    journal_sessions: read('journal_sessions'),
    journal_rows: read('journal_rows'),
    journal_repairs: read('journal_repairs'),
    journal_imports: read('journal_imports'),
    journal_set_aside: read('journal_set_aside'),
    queued_messages: read('queued_messages'),
    agent_session_command_receipts: read('agent_session_command_receipts')
  }
}

/** Inside the caller's journal transaction; any existing row for the session fails the insert. */
export function insertOrcadMigrationAgentSessionTableRows(
  db: Database.Database,
  sessionId: string,
  rows: OrcadMigrationAgentSessionTableRows
): void {
  for (const table of ORCAD_MIGRATION_AGENT_SESSION_TABLE_NAMES) {
    const columns = orcadMigrationAgentSessionColumns(table)
    const insert = db.prepare(
      `INSERT INTO ${table} (session_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`
    )
    for (const row of rows[table]) {
      insert.run(sessionId, ...columns.map((column) => row[column] ?? null))
    }
  }
}

export function orcadMigrationAgentSessionHasRows(
  rows: OrcadMigrationAgentSessionTableRows
): boolean {
  return ORCAD_MIGRATION_AGENT_SESSION_TABLE_NAMES.some((table) => rows[table].length > 0)
}

function existingTables(db: Database.Database): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .flatMap((row) => (typeof row.name === 'string' ? [row.name] : []))
  )
}

function cells(
  table: OrcadMigrationAgentSessionTable,
  columns: readonly string[],
  row: SqliteRow
): OrcadMigrationAgentSessionRow {
  return Object.fromEntries(columns.map((column) => [column, cell(table, column, row[column])]))
}

// Journal columns hold text and safe integers only; anything else is not a row this build wrote.
function cell(table: string, column: string, value: unknown): OrcadMigrationAgentSessionCell {
  if (value === null || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) {
    return Number(value)
  }
  throw new Error(`orcad_migration_agent_session_cell_unreadable:${table}.${column}`)
}
