import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { OrcadMigrationManifest } from '../shared/orcad-migration-manifest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './native-chat/agent-session-journal/journal-host-database-test-support'
import { readAgentSessionHistory } from './native-chat/agent-session-wire/agent-session-history-page'
import { openStructuredAgentSessionConversationJournal } from './native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import { parseOrcadMigrationAgentSessionDocument } from './persistence/migrating-orcad-catalog/orcad-migration-agent-session-format'
import { readOrcadMigrationAgentSessionTableRows } from './persistence/migrating-orcad-catalog/orcad-migration-agent-session-rows'
import type { AgentSessionRecordStore } from './runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from './runtime/agent-session-record-store-test-harness'
import { commitStagedOrcadMigrationCatalogDurably } from './runtime/orcad-migration-catalog-import'
import { createOrcadMigrationAgentSessionJournal } from './runtime/orcad-migration-agent-session-journal'
import { DORMANT_WORKTREE_ID, manifest } from './persistence-orcad-migration-catalog-fixture'
import {
  OTHER_SESSION_ID,
  SESSION_ID,
  SOURCE_WORKTREE_ID,
  TAB_ID,
  exportedSessionBlobs,
  rawSessionBlob,
  seedDesktopSession,
  type EncodedSessionBlob
} from './persistence-orcad-migration-agent-session-fixture'
import { noLiveShells, stage } from './persistence-orcad-migration-shell-history-fixture'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

const FOLDER_KEY = folderWorkspaceKey('folder-1')
const MOVED = [
  { sourceWorkspaceId: SOURCE_WORKTREE_ID, destinationWorkspaceId: DORMANT_WORKTREE_ID },
  { sourceWorkspaceId: FOLDER_KEY, destinationWorkspaceId: FOLDER_KEY }
]
const HOST_LOCATION = {
  executionHostId: 'local' as const,
  wslDistro: null,
  workspaceId: DORMANT_WORKTREE_ID,
  workspaceKind: 'git-worktree' as const
}
const SILENT_LOGGER = { warn: () => {}, error: () => {} }

let desktop: string
let host: string

type HostJournal = {
  store: AgentSessionRecordStore
  journal: ReturnType<typeof createOrcadMigrationAgentSessionJournal>
}

async function openHost(): Promise<HostJournal> {
  const store = await openTestAgentSessionRecordStore(host)
  const journalDatabase = openTestJournalHostDatabase(host)
  return { store, journal: createOrcadMigrationAgentSessionJournal({ journalDatabase, store }) }
}

async function movedSessions(): Promise<EncodedSessionBlob[]> {
  await seedDesktopSession(desktop)
  await seedDesktopSession(desktop, { sessionId: OTHER_SESSION_ID, workspaceId: FOLDER_KEY })
  return exportedSessionBlobs(desktop, MOVED)
}

function receivedPath(input: OrcadMigrationManifest, key: string): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'agent-session-records',
    key
  })
}

function blobFor(blobs: readonly EncodedSessionBlob[], key: string): EncodedSessionBlob {
  const blob = blobs.find((entry) => entry.descriptor.key === key)
  if (!blob) {
    throw new Error(`no blob for ${key}`)
  }
  return blob
}

async function commit(
  store: ReturnType<typeof createStore>,
  input: OrcadMigrationManifest,
  journal?: HostJournal['journal']
): Promise<string> {
  const result = await commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    worktreeHasLiveShells: noLiveShells,
    ...(journal ? { agentSessionJournal: journal } : {}),
    onDurableCommit: () => {}
  })
  return result.state
}

describe('orcad migration native chat sessions through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-agent-sessions-'))
    desktop = mkdtempSync(join(tmpdir(), 'orca-desktop-journal-'))
    host = mkdtempSync(join(tmpdir(), 'orca-host-journal-'))
  })

  afterEach(() => {
    closeTestJournalHostDatabases()
    for (const directory of [testState.dir, desktop, host]) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('installs every row, lists the session for its worktree, and reads its turns back', async () => {
    const input = manifest()
    const store = createStore()
    const blobs = await movedSessions()
    const { store: records, journal } = await openHost()
    stage(store, input, blobs)

    expect(await commit(store, input, journal)).toBe('committed')

    const document = parseOrcadMigrationAgentSessionDocument(
      SESSION_ID,
      blobFor(blobs, SESSION_ID).bytes
    )
    const { db } = openTestJournalHostDatabase(host)
    expect(readOrcadMigrationAgentSessionTableRows(db, SESSION_ID)).toEqual(document.tables)
    for (const blob of blobs) {
      expect(existsSync(receivedPath(input, blob.descriptor.key))).toBe(false)
    }
    expect(records.listByScope(HOST_LOCATION).map((record) => record.sessionId)).toEqual([
      SESSION_ID
    ])
    expect(records.getRecord(OTHER_SESSION_ID)?.location.workspaceId).toBe(FOLDER_KEY)
    expect(
      records.getOperationRow('caller-desktop', document.operations[0].row.operationId)
    ).toEqual(document.operations[0].row)

    // The read path a resume and `agentSession.history` take on the host.
    const record = records.getRecord(SESSION_ID)
    if (!record) {
      throw new Error('moved session missing')
    }
    const { session } = await openStructuredAgentSessionConversationJournal(
      { store: records, journalDatabase: openTestJournalHostDatabase(host), logger: SILENT_LOGGER },
      record
    )
    const history = readAgentSessionHistory(session.journal, {
      sessionId: SESSION_ID,
      direction: 'tail'
    })
    await session.journal.close()
    expect(history.ok).toBe(true)
    const texts = history.ok
      ? history.page.items.flatMap((item) =>
          item.body.kind === 'message'
            ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
            : []
        )
      : []
    expect(texts).toEqual(['add a test', 'added the test'])
  })

  it('shows the moved chat tab where the host already keeps a tab index', async () => {
    const input = manifest()
    const store = createStore()
    const blobs = await movedSessions()
    const hostChat = '0f0e0d0c-0000-4000-8000-000000000009'
    await seedDesktopSession(host, {
      sessionId: hostChat,
      location: { wslDistro: null, workspaceId: 'repo-2::/srv/host-only' }
    })
    const { store: records, journal } = await openHost()
    await records.showSessionTabs([hostChat])
    stage(store, input, blobs)

    await commit(store, input, journal)

    expect(records.getSessionTabId(SESSION_ID)).toBe(`${TAB_ID}-${SESSION_ID}`)
    expect(records.listVisibleSessionIds()).toEqual([hostChat, SESSION_ID, OTHER_SESSION_ID])
  })

  it('writes a session in one transaction: a failing row leaves nothing and keeps the blob', async () => {
    const input = manifest()
    const store = createStore()
    await seedDesktopSession(desktop)
    const [exported] = await exportedSessionBlobs(desktop, MOVED)
    const document = parseOrcadMigrationAgentSessionDocument(SESSION_ID, exported.bytes)
    const duplicated = rawSessionBlob(SESSION_ID, {
      ...document,
      tables: {
        ...document.tables,
        journal_rows: [...document.tables.journal_rows, document.tables.journal_rows[0]]
      }
    })
    const { store: records, journal } = await openHost()
    stage(store, input, [duplicated])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await commit(store, input, journal)).toBe('committed')

    errors.mockRestore()
    expect(records.getRecord(SESSION_ID)).toBeNull()
    expect(
      Object.values(
        readOrcadMigrationAgentSessionTableRows(openTestJournalHostDatabase(host).db, SESSION_ID)
      ).flat()
    ).toEqual([])
    expect(existsSync(receivedPath(input, SESSION_ID))).toBe(true)
  })

  it('waits without the journal, then installs on a retry; a repeat only deletes the blob', async () => {
    const input = manifest()
    const store = createStore()
    const blobs = await movedSessions()
    stage(store, input, blobs)

    expect(await commit(store, input)).toBe('committed')
    expect(existsSync(receivedPath(input, SESSION_ID))).toBe(true)
    expect(store.hasPendingOrcadMigrationAgentSessions()).toBe(true)

    const { store: records, journal } = await openHost()
    store.installPendingOrcadMigrationReceivedBlobs({ agentSessionJournal: journal })
    expect(records.getRecord(SESSION_ID)).not.toBeNull()
    expect(store.hasPendingOrcadMigrationAgentSessions()).toBe(false)

    // A crash between the journal commit and the delete leaves the blob; the retry only deletes it.
    const { db } = openTestJournalHostDatabase(host)
    const rowsBefore = readOrcadMigrationAgentSessionTableRows(db, SESSION_ID)
    const path = receivedPath(input, SESSION_ID)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, blobFor(blobs, SESSION_ID).bytes)
    store.installOrcadMigrationReceivedBlobs(input, { agentSessionJournal: journal })
    expect(existsSync(path)).toBe(false)
    expect(readOrcadMigrationAgentSessionTableRows(db, SESSION_ID)).toEqual(rowsBefore)

    // Identical rows without the marker count as installed too.
    db.prepare("DELETE FROM agent_session_store_meta WHERE key LIKE 'orcad-migration-%'").run()
    writeFileSync(path, blobFor(blobs, SESSION_ID).bytes)
    store.installOrcadMigrationReceivedBlobs(input, { agentSessionJournal: journal })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses before commit a session the host holds with other content', async () => {
    const input = manifest()
    const store = createStore()
    const blobs = await movedSessions()
    await seedDesktopSession(host)
    const { journal } = await openHost()
    stage(store, input, blobs)

    await expect(commit(store, input, journal)).rejects.toThrow(
      'orcad_migration_blob_content_invalid:agent-session-records:orcad_migration_agent_session_conflict'
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })

  it('refuses a conflict found only at install, keeping the blob and the host session', async () => {
    const input = manifest()
    const store = createStore()
    const blobs = await movedSessions()
    stage(store, input, blobs)
    expect(await commit(store, input)).toBe('committed')
    const existing = await seedDesktopSession(host)
    const { store: records, journal } = await openHost()

    expect(() =>
      store.installOrcadMigrationReceivedBlobs(input, { agentSessionJournal: journal })
    ).toThrow(`orcad_migration_agent_session_conflict:${SESSION_ID}`)
    expect(existsSync(receivedPath(input, SESSION_ID))).toBe(true)
    expect(records.getRecord(SESSION_ID)?.location).toEqual(existing.location)
    expect(records.getRecord(OTHER_SESSION_ID)).not.toBeNull()
  })

  it('refuses before commit another journal schema version and a workspace outside the catalog', async () => {
    await seedDesktopSession(desktop)
    const [exported] = await exportedSessionBlobs(desktop, MOVED)
    const document = parseOrcadMigrationAgentSessionDocument(SESSION_ID, exported.bytes)
    const outside = await exportedSessionBlobs(desktop, [
      { sourceWorkspaceId: SOURCE_WORKTREE_ID, destinationWorkspaceId: 'repo-other::/srv/other' }
    ])
    for (const [blob, reason] of [
      [rawSessionBlob(SESSION_ID, { ...document, schemaVersion: 3 }), 'schema_unsupported:3'],
      [rawSessionBlob(SESSION_ID, { ...document, schemaVersion: 5 }), 'schema_unsupported:5'],
      [rawSessionBlob(SESSION_ID, { ...document, sessionId: OTHER_SESSION_ID }), 'key_mismatch'],
      [outside[0], 'workspace_not_migrated']
    ] as const) {
      const input = manifest()
      const store = createStore()
      stage(store, input, [blob])
      expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
        `orcad_migration_blob_content_invalid:agent-session-records:orcad_migration_agent_session_${reason}`
      )
      store.abortStagedOrcadMigrationCatalog(input)
    }
  })
})
