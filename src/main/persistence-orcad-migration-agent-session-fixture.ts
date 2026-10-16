// Native chat sessions as the desktop holds them before a WSL move, and the blobs it would send.

import { createHash } from 'node:crypto'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../shared/agent-session-journal-types'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../shared/agent-session-record'
import { encodeAgentSessionRecord } from '../shared/agent-session-record-stored-form'
import type { OrcadMigrationBlobDescriptor } from '../shared/orcad-migration-blob-transfer'
import { openTestJournalHostDatabase } from './native-chat/agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from './native-chat/agent-session-journal/journal-store-factory'
import { agentSessionRecordFixture } from './native-chat/agent-session-record-test-fixture'
import {
  buildWslMoveAgentSessionBlobs,
  type WslMoveAgentSessionWorkspace
} from './persistence/moving-wsl-projects/wsl-move-agent-session-blobs'
import type Database from './sqlite/sync-database'

export const DISTRO = 'Ubuntu'
export const SOURCE_WORKTREE_ID = 'repo-1::\\\\wsl.localhost\\Ubuntu\\srv\\repo-1-worktree'
export const SESSION_ID = '0f0e0d0c-0000-4000-8000-000000000001'
export const OTHER_SESSION_ID = '0f0e0d0c-0000-4000-8000-000000000002'
export const UNC_LAUNCH_DIRECTORY = '\\\\wsl.localhost\\Ubuntu\\srv\\repo-1-worktree'
export const UNC_ACCOUNT_HOME = '\\\\wsl$\\Ubuntu\\home\\me\\.claude'
export const TAB_ID = 'tab-chat-1'
const NOW = 1_760_000_000_000

export type EncodedSessionBlob = { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer }

export type DesktopSessionSeed = {
  sessionId?: string
  workspaceId?: string
  record?: Partial<Omit<AgentSessionRecord, 'location' | 'sessionId'>>
  location?: Partial<AgentSessionRecord['location']>
}

export function desktopSessionRecord(seed: DesktopSessionSeed = {}): AgentSessionRecord {
  const sessionId = seed.sessionId ?? SESSION_ID
  return agentSessionRecordFixture({
    sessionId,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: UNC_ACCOUNT_HOME },
    launchDirectory: UNC_LAUNCH_DIRECTORY,
    ...seed.record,
    location: {
      wslDistro: DISTRO,
      workspaceId: seed.workspaceId ?? SOURCE_WORKTREE_ID,
      workspaceKind: 'git-worktree',
      ...seed.location
    }
  })
}

export function operationRow(sessionId: string): AgentSessionOperationRow {
  return {
    callerKey: 'caller-desktop',
    operationId: `${NOW}-${createHash('md5').update(sessionId).digest('hex')}`,
    fingerprint: 'fingerprint',
    operationTimestamp: NOW,
    recordedAt: NOW,
    expiresAt: NOW + 60_000,
    outcome: { status: 'succeeded', sessionId }
  }
}

/** One idle session with a turn, a queued draft, a command receipt, a tab and a ledger row. */
export async function seedDesktopSession(
  stateDirectory: string,
  seed: DesktopSessionSeed = {}
): Promise<AgentSessionRecord> {
  const database = openTestJournalHostDatabase(stateDirectory)
  const record = desktopSessionRecord(seed)
  const { sessionId } = record
  const { db } = database
  db.prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)').run(
    sessionId,
    JSON.stringify(encodeAgentSessionRecord(record))
  )
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: record.location.workspaceId,
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    },
    database
  })
  for (const [ordinal, role, text] of [
    [0, 'user', 'add a test'],
    [1, 'assistant', 'added the test']
  ] as const) {
    await journal.appendItem(
      { provider: 'claude', sessionId: 'provider-session-1', uuid: `item-${ordinal}` },
      { kind: 'message', role, blocks: [{ type: 'text', text }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.close()
  insertQueuedDraft(db, sessionId)
  db.prepare(
    `INSERT INTO agent_session_command_receipts
       (operation_id, session_id, caller_key, method, fingerprint, status, result_json, rejection_json, accepted_at)
     VALUES (?, ?, 'caller-desktop', 'agentSession.send', 'fp', 'accepted', ?, NULL, ?)`
  ).run(`op-${sessionId}`, sessionId, JSON.stringify({ kind: 'stop' }), NOW)
  db.prepare('INSERT INTO agent_session_tabs (tab_id, session_id, position) VALUES (?, ?, 0)').run(
    `${TAB_ID}-${sessionId}`,
    sessionId
  )
  const operation = operationRow(sessionId)
  db.prepare('INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)').run(
    agentSessionOperationKey(operation.callerKey, operation.operationId),
    JSON.stringify(operation)
  )
  return record
}

function insertQueuedDraft(db: Database.Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO queued_messages
       (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state)
     VALUES (?, 'draft-1', 0, ?, 'fp', ?, 'desktop-instance', 'queued')`
  ).run(
    sessionId,
    JSON.stringify({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] }),
    NOW
  )
}

/** What the desktop sends, read back whole through the blob source. */
export async function exportedSessionBlobs(
  stateDirectory: string,
  workspaces: readonly WslMoveAgentSessionWorkspace[]
): Promise<EncodedSessionBlob[]> {
  const blobs = buildWslMoveAgentSessionBlobs({
    distro: DISTRO,
    journal: openTestJournalHostDatabase(stateDirectory).db,
    workspaces
  })
  return Promise.all(
    blobs.descriptors.map(async (descriptor) => ({
      descriptor,
      bytes: await blobs.source.readChunk(descriptor, 0, descriptor.byteLength)
    }))
  )
}

/** A hand-built document, for the shapes a correct sender never sends. */
export function rawSessionBlob(key: string, document: unknown): EncodedSessionBlob {
  const bytes = Buffer.from(JSON.stringify(document), 'utf8')
  return {
    bytes,
    descriptor: {
      blobKind: 'agent-session-records',
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}
