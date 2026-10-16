/**
 * The `agent-session-records` blob: one native chat session's rows from the chat journal database
 * as one JSON document. Rows keep their stored values; the sender has already rewritten the record's
 * location, launch directory and account home (and the journal's workspace id) for the destination.
 */
import { z } from 'zod'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { PersistedAgentSessionRecord } from '../../../shared/agent-session-legacy-handoff-lease'
import type { AgentSessionOperationRow } from '../../../shared/agent-session-operation-ledger'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import { JOURNAL_DB_SCHEMA_VERSION } from '../../native-chat/agent-session-journal/journal-database-schema'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord
} from '../../runtime/agent-session-store-row-rules'

/**
 * Equal to the journal database schema version the document was read from. A destination on any
 * other version refuses it: converting between journal shapes here could drop what one side holds.
 */
export const ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION = JOURNAL_DB_SCHEMA_VERSION

export const MAX_ORCAD_MIGRATION_AGENT_SESSION_BYTES =
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['agent-session-records'].maxBytes

const text = z.string()
const optionalText = z.string().nullable()
const integer = z.number().int()
const optionalInteger = z.number().int().nullable()

/**
 * Every journal table keyed by session, by column (`session_id` aside: the document names the
 * session once). Host-wide tables move nothing: `agent_session_store_meta` and
 * `agent_session_retired_claim_keys` describe this host's store and keys, and
 * `agent_session_attachment_sweeps` is an in-progress deletion of this host's files. Attachment
 * claims never move: a session holding one blocks the move (its files live on the source).
 */
export const ORCAD_MIGRATION_AGENT_SESSION_TABLES = {
  journal_sessions: {
    orderBy: 'epoch',
    columns: { workspace_id: text, epoch: text }
  },
  journal_rows: {
    orderBy: 'epoch, seq',
    columns: { epoch: text, seq: integer, ts: integer, row_json: text }
  },
  journal_repairs: {
    orderBy: 'epoch',
    columns: { epoch: text, content_from: integer, repaired_at: integer }
  },
  journal_imports: { orderBy: 'epoch', columns: { epoch: text, tip: integer } },
  journal_set_aside: { orderBy: 'epoch', columns: { epoch: text, tip: integer } },
  queued_messages: {
    orderBy: 'message_id',
    columns: {
      message_id: text,
      position: integer,
      body_json: text,
      fingerprint: text,
      created_at: integer,
      host_instance: text,
      state: text,
      hold_reason: optionalText,
      returned_reason: optionalText,
      returned_rejection: optionalText,
      settled_at: optionalInteger,
      settled_by_op: optionalText,
      consumed_as: optionalText,
      carried_from: optionalText,
      queued_epoch: optionalText,
      queued_sequence: optionalInteger,
      options_json: optionalText
    }
  },
  agent_session_command_receipts: {
    orderBy: 'operation_id, caller_key',
    columns: {
      operation_id: text,
      caller_key: text,
      method: text,
      fingerprint: text,
      status: text,
      result_json: optionalText,
      rejection_json: optionalText,
      accepted_at: integer
    }
  }
} as const

export type OrcadMigrationAgentSessionTable = keyof typeof ORCAD_MIGRATION_AGENT_SESSION_TABLES

/** In insert order: the receipts' foreign key needs the record, which the store writes first. */
export const ORCAD_MIGRATION_AGENT_SESSION_TABLE_NAMES: readonly OrcadMigrationAgentSessionTable[] =
  [
    'journal_sessions',
    'journal_rows',
    'journal_repairs',
    'journal_imports',
    'journal_set_aside',
    'queued_messages',
    'agent_session_command_receipts'
  ]

export type OrcadMigrationAgentSessionCell = string | number | null
export type OrcadMigrationAgentSessionRow = Record<string, OrcadMigrationAgentSessionCell>
export type OrcadMigrationAgentSessionTableRows = Record<
  OrcadMigrationAgentSessionTable,
  OrcadMigrationAgentSessionRow[]
>

export function orcadMigrationAgentSessionColumns(
  table: OrcadMigrationAgentSessionTable
): string[] {
  return Object.keys(ORCAD_MIGRATION_AGENT_SESSION_TABLES[table].columns)
}

const tables = ORCAD_MIGRATION_AGENT_SESSION_TABLES

// Strict: a column this build does not know would otherwise be dropped on insert.
const OrcadMigrationAgentSessionTablesSchema = z.strictObject({
  journal_sessions: z.array(z.strictObject(tables.journal_sessions.columns)).max(1),
  journal_rows: z.array(z.strictObject(tables.journal_rows.columns)),
  journal_repairs: z.array(z.strictObject(tables.journal_repairs.columns)).max(1),
  journal_imports: z.array(z.strictObject(tables.journal_imports.columns)).max(1),
  journal_set_aside: z.array(z.strictObject(tables.journal_set_aside.columns)).max(1),
  queued_messages: z.array(z.strictObject(tables.queued_messages.columns)),
  agent_session_command_receipts: z.array(
    z.strictObject(tables.agent_session_command_receipts.columns)
  )
})

export const OrcadMigrationAgentSessionDocumentSchema = z.strictObject({
  schemaVersion: z.literal(ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION),
  sessionId: z.string().min(1).max(128),
  /** The stored record row, as `agent_session_records.record_json` holds it. */
  record: z.unknown(),
  /** The session's chat tab on the source, when it had one. */
  tabId: z.string().min(1).max(512).nullable(),
  /** Ledger rows whose recorded outcome is this session. */
  operations: z.array(z.strictObject({ operationKey: z.string().min(1), row: z.unknown() })),
  tables: OrcadMigrationAgentSessionTablesSchema
})

export type OrcadMigrationAgentSessionOperation = {
  operationKey: string
  row: AgentSessionOperationRow
}

export type OrcadMigrationAgentSessionDocument = {
  schemaVersion: typeof ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION
  sessionId: string
  record: PersistedAgentSessionRecord
  tabId: string | null
  operations: OrcadMigrationAgentSessionOperation[]
  tables: OrcadMigrationAgentSessionTableRows
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

export function encodeOrcadMigrationAgentSessionDocument(
  document: OrcadMigrationAgentSessionDocument
): Buffer {
  return Buffer.from(JSON.stringify(document), 'utf8')
}

/** Throws unless `bytes` is a session document this build can install under blob key `key`. */
export function parseOrcadMigrationAgentSessionDocument(
  key: string,
  bytes: Buffer
): OrcadMigrationAgentSessionDocument {
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch {
    throw new Error('orcad_migration_agent_session_not_json')
  }
  const version =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? value.schemaVersion
      : undefined
  if (version !== ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION) {
    throw new Error(
      `orcad_migration_agent_session_schema_unsupported:${String(version)}: this host's chat journal is version ${ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION}`
    )
  }
  const parsed = OrcadMigrationAgentSessionDocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `orcad_migration_agent_session_invalid:${parsed.error.issues[0]?.path.join('.') ?? ''}`
    )
  }
  const { sessionId, record, operations } = parsed.data
  if (sessionId !== key) {
    throw new Error('orcad_migration_agent_session_key_mismatch')
  }
  if (!isReadableAgentSessionStoreRecord(sessionId, record)) {
    throw new Error('orcad_migration_agent_session_record_invalid')
  }
  // The sender rewrites the location for this host: the session runs here, natively.
  if (!isNativeLocalLocation(record.location)) {
    throw new Error('orcad_migration_agent_session_location_not_rewritten')
  }
  const journalSession = parsed.data.tables.journal_sessions[0]
  if (journalSession && journalSession.workspace_id !== record.location.workspaceId) {
    throw new Error('orcad_migration_agent_session_workspace_mismatch')
  }
  return {
    ...parsed.data,
    record,
    operations: operations.map(({ operationKey, row }) => {
      if (
        !isReadableAgentSessionStoreOperation(operationKey, row) ||
        row.outcome.status !== 'succeeded' ||
        row.outcome.sessionId !== sessionId
      ) {
        throw new Error('orcad_migration_agent_session_operation_invalid')
      }
      return { operationKey, row }
    })
  }
}
