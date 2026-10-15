import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { createJournalTablesSql } from './journal-database-schema'
import { ensureJournalTextPieceSchema } from './journal-text-piece-schema'
import { JournalHostDatabase } from './journal-host-database'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { insertJournalRow, publishJournalSessionEpoch, readJournalRowsAfter } from './journal-row-table'
import { replayJournal, readJournalRowsAfterCursor } from './journal-open'
import { JournalTextPieceReader } from './journal-text-piece-reader'
import { renderJournalState } from './journal-reducer'
import type { JournalItemRow, JournalRow } from './journal-row-schema'
import { boundInlineText, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'

const SESSION = 'piece-session'
const EPOCH = 'piece-epoch'
let root: string
let host: JournalHostDatabase

function item(seq: number, text: string, itemId = 'assistant'): JournalItemRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: EPOCH, seq, fence: 1, ts: seq,
    kind: 'item', itemId, revision: seq, ownerFence: 1,
    agentId: itemId, turnScope: { kind: 'turn', turnItemId: `turn-${itemId}` },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function put(row: JournalRow, hint?: AgentJournalRenderItem): void {
  host.transaction((db) => insertJournalRow(db, SESSION, row, row.ts, hint))
}

function legacyRows(): unknown[] {
  return host.db.prepare(`SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? ORDER BY seq`).all(SESSION, EPOCH)
    .map((record) => typeof record.row_json === 'string' ? JSON.parse(record.row_json) : null)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-text-pieces-'))
  host = JournalHostDatabase.open(root)
  host.transaction((db) => publishJournalSessionEpoch(db, { sessionId: SESSION, workspaceId: 'ws' }, EPOCH))
  put({ v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: EPOCH, seq: 1, fence: 1, ts: 1, kind: 'epoch',
    reason: 'session_created', providerHandle: { kind: 'codex', threadId: 'thread' } })
})

afterEach(async () => {
  vi.restoreAllMocks()
  host.close()
  await rm(root, { recursive: true, force: true })
})

describe('piece storage through the existing journal contract', () => {
  it('replays interleaved text, rollback/retry, attribution and authoritative replacements for old and new readers', () => {
    const prefix = `quotes "\\\n\0 combining e\u0301 astral 😀 ${'a'.repeat(64)}`
    const writes = [item(2, `${prefix}\ud83d`), item(3, 'reasoning', 'other'),
      item(4, `${prefix}😀 continued`), item(5, 'reasoning continued', 'other')]
    for (const row of writes) {
      put(row)
    }
    const hint = replayJournal(host.db, SESSION)?.state.items.get('assistant')
    host.db.exec(`CREATE TEMP TRIGGER refuse_piece BEFORE INSERT ON journal_text_pieces
WHEN NEW.seq = 6 BEGIN SELECT RAISE(ABORT, 'refused piece'); END`)
    const retried = item(6, `${prefix}😀 continued after retry`)
    expect(() => put(retried, hint)).toThrow('refused piece')
    expect(legacyRows()).toHaveLength(5)
    host.db.exec('DROP TRIGGER refuse_piece')
    put(retried, hint)
    const attributed = { ...item(7, `${prefix}😀 continued after retry`), agentId: 'resolved-agent', attempt: 2 }
    put(attributed, hint)
    const final = item(8, 'authoritative shorter final')
    put(final)
    const expected = legacyRows()
    expect(expected.slice(1)).toEqual([...writes, retried, attributed, final])
    const before = replayJournal(host.db, SESSION)
    expect(before?.damage).toBeNull()
    const snapshot = before ? renderJournalState(before.state) : null
    host.close()
    host = JournalHostDatabase.open(root)
    const loaded = replayJournal(host.db, SESSION)
    expect(loaded?.damage).toBeNull()
    expect(loaded ? renderJournalState(loaded.state) : null).toEqual(snapshot)
    expect(legacyRows()).toEqual(expected)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 1)).toEqual(expected.slice(1))
    expect(readJournalRowsAfter(host.db, SESSION, EPOCH, 1).map((row) => JSON.parse(row.rowJson)))
      .toEqual(expected.slice(1))
  })

  it('shares bounded text heads when truncation markers and output metadata change', () => {
    let expandedBytes = 0
    for (let index = 0; index < 96; index += 1) {
      const original = 'x'.repeat(17_000 + index * 400)
      const bounded = boundInlineText(original, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
      const message = item(2 + index * 4, bounded.text)
      const output: JournalItemRow = { ...item(3 + index * 4, '', 'command'),
        body: { kind: 'tool-call', name: 'command', input: {}, state: 'running', output: bounded.bounded } }
      const patch: JournalItemRow = { ...item(4 + index * 4, '', 'patch'),
        body: { kind: 'diff', path: 'file.ts', patch: bounded.bounded } }
      const plan: JournalItemRow = { ...item(5 + index * 4, '', 'plan'),
        body: { kind: 'status', text: bounded.text, presentation: 'plan-document' } }
      put(message)
      put(output)
      put(patch)
      put(plan)
      expandedBytes += [message, output, patch, plan]
        .reduce((bytes, row) => bytes + JSON.stringify(row).length, 0)
    }
    const physical = host.db.prepare(`SELECT
 (SELECT SUM(length(row_json)) FROM journal_rows_data) +
 (SELECT SUM(length(suffix)) FROM journal_text_pieces) AS bytes`).get()?.bytes
    expect(typeof physical).toBe('number')
    expect(physical).toBeLessThan(expandedBytes / 4)
    const prefix = 'head-'.repeat(32)
    const branch = [`${prefix}left`, `${prefix}left extended`, `${prefix}right`,
      `${prefix}right extended`, `${prefix}left final`, prefix, '']
      .map((text, index) => item(386 + index, text, 'branch'))
    for (const row of branch) put(row)
    const expected = legacyRows()
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 0)).toEqual(expected)
    const generation = host.db.prepare('SELECT text_generation FROM journal_rows_data WHERE seq = 386')
      .get()?.text_generation
    if (typeof generation !== 'string') throw new Error('missing branch generation')
    const reader = new JournalTextPieceReader(host.db)
    expect(reader.read(SESSION, EPOCH, generation, 388)).toBe(`${prefix}right`)
    // The cached right branch no longer retains the older left extension's required prefix.
    expect(reader.read(SESSION, EPOCH, generation, 387)).toBe(`${prefix}left extended`)
    expect(reader.read(SESSION, EPOCH, generation, 390)).toBe(`${prefix}left final`)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 391, 1)).toEqual([branch[6]])
    host.db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE seq = 388').run('damaged')
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 389, 1)).toEqual([branch[4]])
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 387, 1)).toEqual([])
    expect(host.db.prepare('SELECT row_json FROM journal_rows WHERE seq = 390').get()?.row_json)
      .toBe(JSON.stringify(branch[4]))
    expect(host.db.prepare('SELECT row_json FROM journal_rows WHERE seq = 388').get()?.row_json).toBe('{')
    expect(replayJournal(host.db, SESSION)?.damage?.sequence).toBe(388)
    host.db.prepare('DELETE FROM journal_text_pieces WHERE seq = 386').run()
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 389, 1)).toEqual([])
    expect(host.db.prepare('SELECT row_json FROM journal_rows WHERE seq = 390').get()?.row_json).toBe('{')
    host.db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE seq = 2').run('damaged')
    expect(replayJournal(host.db, SESSION)?.damage?.sequence).toBe(2)
    expect(host.db.prepare('SELECT row_json FROM journal_rows WHERE seq = 2').get()?.row_json)
      .toBe('{')
  })

  it('allows legacy raw writes, updates and suffix reuse without mutating surviving text', () => {
    const prefix = 'shared prefix '.repeat(8)
    put(item(2, prefix))
    put(item(3, `${prefix}first suffix`))
    put(item(4, `${prefix}second suffix`))
    const oldInsert = host.db.prepare('INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)')
    const raw = item(5, `${prefix}old host replacement`)
    oldInsert.run(SESSION, EPOCH, raw.seq, raw.ts, JSON.stringify(raw))
    const continued = item(6, `${prefix}old host replacement continued`)
    put(continued)
    host.db.prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND epoch = ? AND seq = 2')
      .run(JSON.stringify(item(2, 'updated old revision')), SESSION, EPOCH)
    expect(legacyRows()[2]).toEqual(item(3, `${prefix}first suffix`))
    host.db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq >= 4')
      .run(SESSION, EPOCH)
    const reused = item(4, `${prefix}reused sequence`)
    put(reused)
    expect(legacyRows().at(-1)).toEqual(reused)
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 3)).toEqual([reused])
    host.db.prepare(`DELETE FROM journal_rows WHERE session_id = ?
AND epoch IS NOT (SELECT epoch FROM journal_sessions WHERE session_id = ?)`)
      .run(SESSION, 'unpublished-session')
    expect(host.db.prepare('SELECT COUNT(*) AS n FROM journal_text_pieces').get()?.n).toBe(0)
    expect(host.db.pragma('user_version', { simple: true })).toBe(4)
  })
})

it('migrates the old table atomically and preserves raw bytes at the old database version', () => {
  host.close()
  const path = join(root, 'legacy.db')
  const legacy = new Database(path)
  legacy.exec(createJournalTablesSql())
  legacy.pragma('user_version = 4')
  const original = JSON.stringify(item(1, 'legacy full text'))
  legacy.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(SESSION, EPOCH, 1, 1, original)
  const exec = legacy.exec.bind(legacy)
  const failure = vi.spyOn(legacy, 'exec').mockImplementation((sql) => {
    if (sql.includes('CREATE VIEW journal_rows')) {
      throw new Error('migration interrupted')
    }
    exec(sql)
  })
  expect(() => ensureJournalTextPieceSchema(legacy)).toThrow('migration interrupted')
  failure.mockRestore()
  expect(legacy.prepare("SELECT type FROM sqlite_master WHERE name = 'journal_rows'").get()?.type).toBe('table')
  legacy.close()
  const opened = openJournalDatabase(path)
  expect(opened.db.pragma('user_version', { simple: true })).toBe(4)
  expect(opened.db.prepare('SELECT row_json FROM journal_rows').get()?.row_json).toBe(original)
  opened.db.close()
})
