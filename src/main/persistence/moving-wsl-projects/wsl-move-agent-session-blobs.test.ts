import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { encodeAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { DORMANT_WORKTREE_ID } from '../../persistence-orcad-migration-catalog-fixture'
import {
  DISTRO,
  OTHER_SESSION_ID,
  SESSION_ID,
  SOURCE_WORKTREE_ID,
  TAB_ID,
  exportedSessionBlobs,
  operationRow,
  seedDesktopSession
} from '../../persistence-orcad-migration-agent-session-fixture'
import { parseOrcadMigrationAgentSessionDocument } from '../migrating-orcad-catalog/orcad-migration-agent-session-format'
import { readOrcadMigrationAgentSessionTableRows } from '../migrating-orcad-catalog/orcad-migration-agent-session-rows'
import { buildWslMoveAgentSessionBlobs } from './wsl-move-agent-session-blobs'

const FOLDER_KEY = folderWorkspaceKey('folder-1')
const MOVED = [
  { sourceWorkspaceId: SOURCE_WORKTREE_ID, destinationWorkspaceId: DORMANT_WORKTREE_ID },
  { sourceWorkspaceId: FOLDER_KEY, destinationWorkspaceId: FOLDER_KEY }
]

let desktop: string

function build(): ReturnType<typeof buildWslMoveAgentSessionBlobs> {
  return buildWslMoveAgentSessionBlobs({
    distro: DISTRO,
    journal: openTestJournalHostDatabase(desktop).db,
    workspaces: MOVED
  })
}

function replaceRecord(record: AgentSessionRecord): void {
  openTestJournalHostDatabase(desktop)
    .db.prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?')
    .run(JSON.stringify(encodeAgentSessionRecord(record)), record.sessionId)
}

describe('wsl move agent session blobs', () => {
  beforeEach(() => {
    desktop = mkdtempSync(join(tmpdir(), 'orca-desktop-journal-'))
  })

  afterEach(() => {
    closeTestJournalHostDatabases()
    rmSync(desktop, { recursive: true, force: true })
  })

  it('sends one blob per session of a moved workspace, and none for anything else', async () => {
    await seedDesktopSession(desktop)
    await seedDesktopSession(desktop, { sessionId: OTHER_SESSION_ID, workspaceId: FOLDER_KEY })
    await seedDesktopSession(desktop, {
      sessionId: '0f0e0d0c-0000-4000-8000-000000000003',
      workspaceId: 'repo-2::\\\\wsl.localhost\\Ubuntu\\srv\\other'
    })
    // The same workspace id served by a remote host is that host's session, not this desktop's.
    await seedDesktopSession(desktop, {
      sessionId: '0f0e0d0c-0000-4000-8000-000000000004',
      location: { executionHostId: 'ssh:box', wslDistro: null }
    })

    const blobs = await exportedSessionBlobs(desktop, MOVED)

    expect(blobs.map((blob) => blob.descriptor.key).sort()).toEqual([SESSION_ID, OTHER_SESSION_ID])
    expect(blobs.every((blob) => blob.descriptor.blobKind === 'agent-session-records')).toBe(true)
  })

  it('carries every journal row of the session, rewritten to run natively on the host', async () => {
    await seedDesktopSession(desktop)
    await seedDesktopSession(desktop, { sessionId: OTHER_SESSION_ID, workspaceId: FOLDER_KEY })
    const source = readOrcadMigrationAgentSessionTableRows(
      openTestJournalHostDatabase(desktop).db,
      SESSION_ID
    )

    const blob = (await exportedSessionBlobs(desktop, MOVED)).find(
      (entry) => entry.descriptor.key === SESSION_ID
    )
    const document = parseOrcadMigrationAgentSessionDocument(
      SESSION_ID,
      blob?.bytes ?? Buffer.alloc(0)
    )

    expect(document.record.location).toEqual({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: DORMANT_WORKTREE_ID,
      workspaceKind: 'git-worktree'
    })
    expect(document.record.launchDirectory).toBe('/srv/repo-1-worktree')
    expect(document.record.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/home/me/.claude'
    })
    expect(document.tabId).toBe(`${TAB_ID}-${SESSION_ID}`)
    expect(document.operations.map((entry) => entry.row)).toEqual([operationRow(SESSION_ID)])
    expect(document.tables.journal_rows.length).toBeGreaterThanOrEqual(2)
    expect(document.tables.journal_rows).toEqual(source.journal_rows)
    expect(document.tables.queued_messages).toEqual(source.queued_messages)
    expect(document.tables.agent_session_command_receipts).toEqual(
      source.agent_session_command_receipts
    )
    expect(document.tables.journal_sessions).toEqual([
      { ...source.journal_sessions[0], workspace_id: DORMANT_WORKTREE_ID }
    ])
    expect(source.journal_sessions[0]?.workspace_id).toBe(SOURCE_WORKTREE_ID)
  })

  it('serves the exact bytes its descriptor names, and refuses a changed descriptor', async () => {
    await seedDesktopSession(desktop)
    const { descriptors, source } = build()
    const [descriptor] = descriptors
    const whole = await source.readChunk(descriptor, 0, descriptor.byteLength)
    const head = await source.readChunk(descriptor, 0, 10)

    expect(whole.length).toBe(descriptor.byteLength)
    expect(head.equals(whole.subarray(0, 10))).toBe(true)
    await expect(source.readChunk({ ...descriptor, sha256: 'f'.repeat(64) }, 0, 1)).rejects.toThrow(
      'orcad_migration_source_blob_changed:agent-session-records'
    )
  })

  it.each([
    ['reserved', { claimStatus: 'reserved' as const, reservedSpawnToken: 'spawn' }],
    ['held by a conflicted owner', { claimStatus: 'conflicted' as const }],
    [
      'still naming its process',
      { ownerProcess: { hostId: 'local', pid: 42, processStartTimeMs: null, spawnToken: 'spawn' } }
    ]
  ])('refuses the move while a session is %s', async (_, lease) => {
    const record = await seedDesktopSession(desktop)
    replaceRecord({ ...record, lease: { ...record.lease, ...lease } })

    expect(build).toThrow(`orcad_migration_agent_session_not_movable:in_use:${SESSION_ID}`)
  })

  it('refuses the move for a session holding attachments, or with a path outside the distro', async () => {
    const record = await seedDesktopSession(desktop)
    const { db } = openTestJournalHostDatabase(desktop)
    db.prepare(
      'INSERT INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, 1)'
    ).run('00000000-0000-4000-8000-000000000000', SESSION_ID)
    expect(build).toThrow(`orcad_migration_agent_session_not_movable:attachments:${SESSION_ID}`)

    db.prepare('DELETE FROM agent_session_attachment_claims').run()
    replaceRecord({ ...record, launchDirectory: 'C:\\Users\\me\\repo' })
    expect(build).toThrow(
      `orcad_migration_agent_session_not_movable:launch_directory:${SESSION_ID}`
    )

    replaceRecord({
      ...record,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: 'C:\\Users\\me\\.claude' }
    })
    expect(build).toThrow(`orcad_migration_agent_session_not_movable:account_home:${SESSION_ID}`)
  })

  it('refuses the move for an unreadable session record and an id no blob can carry', async () => {
    await seedDesktopSession(desktop)
    const { db } = openTestJournalHostDatabase(desktop)
    db.prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?').run(
      JSON.stringify({ schemaVersion: 99, location: { workspaceId: SOURCE_WORKTREE_ID } }),
      SESSION_ID
    )
    expect(build).toThrow(`orcad_migration_agent_session_not_movable:unreadable:${SESSION_ID}`)

    db.prepare('DELETE FROM agent_session_records').run()
    await seedDesktopSession(desktop, { sessionId: 'Upper-Case-Session-1' })
    expect(build).toThrow('orcad_migration_agent_session_not_movable:id:Upper-Case-Session-1')
  })

  it('refuses the move for a session over the per-blob cap instead of cutting it', async () => {
    await seedDesktopSession(desktop)
    const { db } = openTestJournalHostDatabase(desktop)
    const epoch = db
      .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
      .get(SESSION_ID)?.epoch
    db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, 1000, 1, ?)'
    ).run(SESSION_ID, epoch ?? '', 'x'.repeat(64 * 1024 * 1024))

    expect(build).toThrow(`orcad_migration_agent_session_not_movable:too_large:${SESSION_ID}`)
  })
})
