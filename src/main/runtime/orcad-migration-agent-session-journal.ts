// The destination's chat journal for moved sessions: rows land in the host's one journal database
// and the record enters the open session store in the same transaction, so the session lists at once.

import { isDeepStrictEqual } from 'node:util'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../shared/agent-session-record-stored-form'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import type { OrcadMigrationAgentSessionJournal } from '../persistence/migrating-orcad-catalog/orcad-agent-session-installer'
import type { OrcadMigrationAgentSessionDocument } from '../persistence/migrating-orcad-catalog/orcad-migration-agent-session-format'
import {
  insertOrcadMigrationAgentSessionTableRows,
  orcadMigrationAgentSessionHasRows,
  readOrcadMigrationAgentSessionTableRows
} from '../persistence/migrating-orcad-catalog/orcad-migration-agent-session-rows'
import type Database from '../sqlite/sync-database'
import {
  movedAgentSessionRecord,
  type MovedAgentSession
} from './agent-session-moved-session-adoption'
import type { OpenedAgentSessionRecordStore } from './agent-session-record-store-slot'

/** `agent_session_store_meta` key whose value is the sha256 of the blob that installed the session. */
const INSTALLED_MARKER_PREFIX = 'orcad-migration-agent-session:'

type HeldSession = 'absent' | 'identical' | 'conflict'

export function createOrcadMigrationAgentSessionJournal({
  journalDatabase,
  store
}: OpenedAgentSessionRecordStore): OrcadMigrationAgentSessionJournal {
  const requireWritable = (): void => {
    if (journalDatabase.readOnly) {
      throw new Error(
        "orcad_migration_agent_session_journal_read_only: a newer Orca wrote this host's chat journal"
      )
    }
  }
  const held = (
    db: Database.Database,
    document: OrcadMigrationAgentSessionDocument
  ): HeldSession => {
    const { sessionId } = document
    const tables = readOrcadMigrationAgentSessionTableRows(db, sessionId)
    const recordRow = readRecordRow(db, sessionId)
    if (
      recordRow === undefined &&
      !store.getRecord(sessionId) &&
      !store.isSessionUnreadable(sessionId) &&
      !orcadMigrationAgentSessionHasRows(tables)
    ) {
      return 'absent'
    }
    return isDeepStrictEqual(recordRow, storedRecord(document)) &&
      isDeepStrictEqual(tables, document.tables) &&
      document.operations.every(({ operationKey, row }) =>
        isDeepStrictEqual(readOperationRow(db, operationKey), row)
      )
      ? 'identical'
      : 'conflict'
  }
  return {
    assertInstallable: (document) => {
      requireWritable()
      if (held(journalDatabase.db, document) === 'conflict') {
        throw conflict(document.sessionId)
      }
    },
    install: (document, sha256) => {
      requireWritable()
      const pending: { receipt: JournalOperationReceipt | null } = { receipt: null }
      const installed = journalDatabase.transaction((db) => {
        if (readInstalledMarker(db, document.sessionId) === sha256) {
          return false
        }
        const state = held(db, document)
        if (state === 'conflict') {
          throw conflict(document.sessionId)
        }
        if (state === 'absent') {
          pending.receipt = store.founding.adoptMovedReceipt(movedSession(document))
          pending.receipt.write(db)
          insertOrcadMigrationAgentSessionTableRows(db, document.sessionId, document.tables)
        }
        db.prepare(
          'INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)'
        ).run(`${INSTALLED_MARKER_PREFIX}${document.sessionId}`, sha256)
        return state === 'absent'
      })
      pending.receipt?.committed()
      return installed
    }
  }
}

function movedSession(document: OrcadMigrationAgentSessionDocument): MovedAgentSession {
  return {
    record: decodePersistedAgentSessionRecord(document.record).record,
    tabId: document.tabId,
    operations: document.operations
  }
}

// What the store writes for the moved record, read back as a load would parse it.
function storedRecord(document: OrcadMigrationAgentSessionDocument): unknown {
  const record = movedAgentSessionRecord(decodePersistedAgentSessionRecord(document.record).record)
  return JSON.parse(JSON.stringify(encodeAgentSessionRecord(record)))
}

function readRecordRow(db: Database.Database, sessionId: string): unknown {
  const json = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
    .get(sessionId)?.record_json
  return parseJson(json)
}

function readOperationRow(db: Database.Database, operationKey: string): unknown {
  return parseJson(
    db
      .prepare('SELECT row_json FROM agent_session_operations WHERE operation_key = ?')
      .get(operationKey)?.row_json
  )
}

function readInstalledMarker(db: Database.Database, sessionId: string): string | null {
  const value = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key = ?')
    .get(`${INSTALLED_MARKER_PREFIX}${sessionId}`)?.value
  return typeof value === 'string' ? value : null
}

// Undefined for no row; a row this build cannot parse compares unequal to anything moved.
function parseJson(json: unknown): unknown {
  if (json === undefined) {
    return undefined
  }
  try {
    return typeof json === 'string' ? JSON.parse(json) : null
  } catch {
    return null
  }
}

function conflict(sessionId: string): Error {
  return new Error(
    `orcad_migration_agent_session_conflict:${sessionId}: this host already holds the chat session ${sessionId} with different content`
  )
}
