/**
 * The moved projects' native chat sessions as `agent-session-records` migration blobs: one session
 * per blob, every journal row it owns, re-addressed to run natively on the WSL host.
 */
import { createHash } from 'node:crypto'
import { isAgentSessionOperationRow } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionAccountHome,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../../shared/agent-session-record-stored-form'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS,
  assertOrcadMigrationBlobSet,
  orcadMigrationBlobIdentity,
  sameOrcadMigrationBlob,
  type OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationBlobSource } from '../../ssh/orcad-migration-blob-coordinator'
import type Database from '../../sqlite/sync-database'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session-store-row-rules'
import {
  MAX_ORCAD_MIGRATION_AGENT_SESSION_BYTES,
  ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION,
  encodeOrcadMigrationAgentSessionDocument,
  type OrcadMigrationAgentSessionDocument,
  type OrcadMigrationAgentSessionOperation
} from '../migrating-orcad-catalog/orcad-migration-agent-session-format'
import { readOrcadMigrationAgentSessionTableRows } from '../migrating-orcad-catalog/orcad-migration-agent-session-rows'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

export type WslMoveAgentSessionWorkspace = {
  /** The desktop's id: a UNC worktree id or a folder workspace key. */
  sourceWorkspaceId: string
  /** The same workspace's id on the host, after the mover's rewrite. */
  destinationWorkspaceId: string
}

export type WslMoveAgentSessionRequest = {
  distro: string
  /** The desktop's chat journal connection; read only. */
  journal: Database.Database
  workspaces: readonly WslMoveAgentSessionWorkspace[]
}

export type WslMoveAgentSessionBlobs = {
  descriptors: OrcadMigrationBlobDescriptor[]
  source: OrcadMigrationBlobSource
}

type SessionBlob = { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer }

type StoredRecordRow = { sessionId: string; value: unknown }

/**
 * Every session whose workspace moves, or the move is refused: a session is never left behind or
 * cut short. Refused when a session is in use (its lease is not released), holds attachments (their
 * files stay on this machine), cannot be read, or would exceed the per-blob cap.
 * Synchronous on the one journal connection, so no write lands between two sessions' reads.
 */
export function buildWslMoveAgentSessionBlobs(
  request: WslMoveAgentSessionRequest
): WslMoveAgentSessionBlobs {
  const destinations = new Map(
    request.workspaces.map((entry) => [entry.sourceWorkspaceId, entry.destinationWorkspaceId])
  )
  const operations = readSessionOperations(request.journal)
  const blobs: SessionBlob[] = []
  for (const { sessionId, value } of readRecordRows(request.journal)) {
    const workspaceId = storedWorkspaceId(value)
    if (workspaceId === null || !destinations.has(workspaceId)) {
      continue
    }
    if (!isReadableAgentSessionStoreRecord(sessionId, value)) {
      throw blocker(sessionId, 'unreadable', 'this Orca cannot read its record')
    }
    const { record } = decodePersistedAgentSessionRecord(value)
    if (record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const destinationWorkspaceId = destinations.get(record.location.workspaceId)
    if (destinationWorkspaceId === undefined) {
      continue
    }
    blobs.push(
      sessionBlob(request, {
        record,
        destinationWorkspaceId,
        operations: operations.get(sessionId) ?? []
      })
    )
  }
  const descriptors = blobs.map((blob) => blob.descriptor)
  assertOrcadMigrationBlobSet(descriptors)
  const byIdentity = new Map(
    blobs.map((blob) => [orcadMigrationBlobIdentity(blob.descriptor), blob])
  )
  return {
    descriptors,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        const blob = byIdentity.get(orcadMigrationBlobIdentity(requested))
        if (!blob || !sameOrcadMigrationBlob(requested, blob.descriptor)) {
          throw new Error(`orcad_migration_source_blob_changed:${requested.blobKind}`)
        }
        return blob.bytes.subarray(offset, offset + maxBytes)
      }
    }
  }
}

function sessionBlob(
  request: WslMoveAgentSessionRequest,
  session: {
    record: AgentSessionRecord
    destinationWorkspaceId: string
    operations: OrcadMigrationAgentSessionOperation[]
  }
): SessionBlob {
  const { record } = session
  const { sessionId } = record
  if (!ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['agent-session-records'].key.test(sessionId)) {
    throw blocker(sessionId, 'id', 'its id cannot name a migration blob')
  }
  // The host has no owner to hand over to; a released lease means no process holds the session.
  if (record.lease.claimStatus !== 'released' || record.lease.ownerProcess !== null) {
    throw blocker(sessionId, 'in_use', 'it is running; stop it and try again')
  }
  if (holdsAttachments(request.journal, sessionId)) {
    throw blocker(sessionId, 'attachments', 'its attached files cannot move yet')
  }
  const tables = readOrcadMigrationAgentSessionTableRows(request.journal, sessionId)
  const document: OrcadMigrationAgentSessionDocument = {
    schemaVersion: ORCAD_MIGRATION_AGENT_SESSION_SCHEMA_VERSION,
    sessionId,
    record: encodeAgentSessionRecord(
      rewriteRecord(record, request.distro, session.destinationWorkspaceId)
    ),
    tabId: readTabId(request.journal, sessionId),
    operations: session.operations,
    tables: {
      ...tables,
      journal_sessions: tables.journal_sessions.map((row) => ({
        ...row,
        workspace_id: session.destinationWorkspaceId
      }))
    }
  }
  const bytes = encodeOrcadMigrationAgentSessionDocument(document)
  // A blocker rather than a cut: dropping turns would lose the conversation without anyone noticing.
  if (bytes.length > MAX_ORCAD_MIGRATION_AGENT_SESSION_BYTES) {
    throw blocker(
      sessionId,
      'too_large',
      `it is ${bytes.length} bytes, over the ${MAX_ORCAD_MIGRATION_AGENT_SESSION_BYTES}-byte limit`
    )
  }
  return {
    bytes,
    descriptor: {
      blobKind: 'agent-session-records',
      key: sessionId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

function rewriteRecord(
  record: AgentSessionRecord,
  distro: string,
  workspaceId: string
): AgentSessionRecord {
  const { sessionId } = record
  return {
    ...record,
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId,
      workspaceKind: record.location.workspaceKind
    },
    accountHome: rewriteAccountHome(record.accountHome, distro, sessionId),
    ...(record.launchDirectory !== undefined
      ? { launchDirectory: hostPath(record.launchDirectory, distro, sessionId, 'launch_directory') }
      : {})
  }
}

function rewriteAccountHome(
  home: AgentSessionAccountHome,
  distro: string,
  sessionId: string
): AgentSessionAccountHome {
  return 'kind' in home
    ? home
    : { ...home, path: hostPath(home.path, distro, sessionId, 'account_home') }
}

// A Windows path would resolve to nothing on the host, and a resume there would start blank.
function hostPath(value: string, distro: string, sessionId: string, field: string): string {
  const linux = wslUncPathToLinux(value, distro) ?? value
  if (!linux.startsWith('/')) {
    throw blocker(
      sessionId,
      field,
      `its ${field.replace('_', ' ')} ${value} is not inside ${distro}`
    )
  }
  return linux
}

function blocker(sessionId: string, reason: string, detail: string): Error {
  return new Error(
    `orcad_migration_agent_session_not_movable:${reason}:${sessionId}: the chat session ${sessionId} cannot move because ${detail}`
  )
}

function readRecordRows(db: Database.Database): StoredRecordRow[] {
  if (!hasTable(db, 'agent_session_records')) {
    return []
  }
  return db
    .prepare('SELECT session_id, record_json FROM agent_session_records ORDER BY session_id')
    .all()
    .flatMap((row) =>
      typeof row.session_id === 'string'
        ? [{ sessionId: row.session_id, value: parseJson(row.record_json) }]
        : []
    )
}

// Read without validation so a record this build cannot read still blocks the move it belongs to.
function storedWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('location' in value)) {
    return null
  }
  const { location } = value
  return typeof location === 'object' &&
    location !== null &&
    'workspaceId' in location &&
    typeof location.workspaceId === 'string'
    ? location.workspaceId
    : null
}

// Only a succeeded outcome names its session; the rest is host-wide retry bookkeeping.
function readSessionOperations(
  db: Database.Database
): Map<string, OrcadMigrationAgentSessionOperation[]> {
  const bySession = new Map<string, OrcadMigrationAgentSessionOperation[]>()
  if (!hasTable(db, 'agent_session_operations')) {
    return bySession
  }
  for (const row of db
    .prepare('SELECT operation_key, row_json FROM agent_session_operations ORDER BY operation_key')
    .all()) {
    const value = parseJson(row.row_json)
    if (
      typeof row.operation_key !== 'string' ||
      !isAgentSessionOperationRow(value) ||
      value.outcome.status !== 'succeeded' ||
      !value.outcome.sessionId
    ) {
      continue
    }
    const entries = bySession.get(value.outcome.sessionId) ?? []
    entries.push({ operationKey: row.operation_key, row: value })
    bySession.set(value.outcome.sessionId, entries)
  }
  return bySession
}

function readTabId(db: Database.Database, sessionId: string): string | null {
  if (!hasTable(db, 'agent_session_tabs')) {
    return null
  }
  const tabId = db
    .prepare('SELECT tab_id FROM agent_session_tabs WHERE session_id = ?')
    .get(sessionId)?.tab_id
  return typeof tabId === 'string' ? tabId : null
}

function holdsAttachments(db: Database.Database, sessionId: string): boolean {
  return (
    hasTable(db, 'agent_session_attachment_claims') &&
    db
      .prepare('SELECT 1 AS held FROM agent_session_attachment_claims WHERE session_id = ? LIMIT 1')
      .get(sessionId) !== undefined
  )
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  )
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
