import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { createJournalTablesSql, JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
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
import { escapeJournalText } from './journal-streamed-text-field'
import { prepareJournalTextSuffix } from './journal-text-suffix-preparation'

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

function logicalRows(): unknown[] {
  return readJournalRowsAfter(host.db, SESSION, EPOCH, 0).map((row) => JSON.parse(row.rowJson))
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
  it('replays interleaved text, rollback/retry, attribution and authoritative replacements through logical reads', () => {
    const prefix = `${'a'.repeat(255)}😀 quotes "\\\n\0 combining e\u0301 astral 😀`
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
    host.db.exec('DROP TRIGGER refuse_piece')
    put(retried, hint)
    const attributed = { ...item(7, `${prefix}😀 continued after retry`), agentId: 'resolved-agent', attempt: 2 }
    put(attributed, hint)
    const final = item(8, 'authoritative shorter final')
    put(final)
    const expected = logicalRows()
    expect(expected.slice(1)).toEqual([...writes, retried, attributed, final])
    const before = replayJournal(host.db, SESSION)
    expect(before?.damage).toBeNull()
    const snapshot = before ? renderJournalState(before.state) : null
    host.close()
    host = JournalHostDatabase.open(root)
    const loaded = replayJournal(host.db, SESSION)
    expect(loaded?.damage).toBeNull()
    expect(loaded ? renderJournalState(loaded.state) : null).toEqual(snapshot)
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
    for (const row of branch) {
      put(row)
    }
    const expected = logicalRows()
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 0)).toEqual(expected)
    const generation = host.db.prepare('SELECT text_generation FROM journal_rows_data WHERE seq = 386')
      .get()?.text_generation
    if (typeof generation !== 'string') {
      throw new Error('missing branch generation')
    }
    const reader = new JournalTextPieceReader(host.db)
    expect(reader.read(SESSION, EPOCH, generation, 388)).toBe(`${prefix}right`)
    // The cached right branch no longer retains the older left extension's required prefix.
    expect(reader.read(SESSION, EPOCH, generation, 387)).toBe(`${prefix}left extended`)
    expect(reader.read(SESSION, EPOCH, generation, 390)).toBe(`${prefix}left final`)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 391, 1)).toEqual([branch[6]])
    host.db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE seq = 388').run('damaged')
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 389, 1)).toEqual([branch[4]])
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 387, 1)).toEqual([])
    expect(readJournalRowsAfter(host.db, SESSION, EPOCH, 389, 1).map((row) => JSON.parse(row.rowJson)))
      .toEqual([branch[4]])
    expect(readJournalRowsAfter(host.db, SESSION, EPOCH, 387, 1)[0]?.rowJson).toBe('{')
    expect(replayJournal(host.db, SESSION)?.damage?.sequence).toBe(388)
    host.db.prepare('DELETE FROM journal_text_pieces WHERE seq = 386').run()
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 389, 1)).toEqual([])
    expect(readJournalRowsAfter(host.db, SESSION, EPOCH, 389, 1)[0]?.rowJson).toBe('{')
    host.db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE seq = 2').run('damaged')
    expect(replayJournal(host.db, SESSION)?.damage?.sequence).toBe(2)
    expect(readJournalRowsAfter(host.db, SESSION, EPOCH, 1, 1)[0]?.rowJson)
      .toBe('{')
  })

  it('reuses a deleted suffix without mutating surviving text and retires unreferenced pieces', () => {
    const prefix = 'shared prefix '.repeat(8)
    put(item(2, prefix))
    put(item(3, `${prefix}first suffix`))
    put(item(4, `${prefix}second suffix`))
    host.db.prepare('DELETE FROM journal_rows_data WHERE session_id = ? AND epoch = ? AND seq >= 4')
      .run(SESSION, EPOCH)
    const reused = item(4, `${prefix}reused sequence`)
    put(reused)
    expect(logicalRows().slice(1)).toEqual([item(2, prefix), item(3, `${prefix}first suffix`), reused])
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 3)).toEqual([reused])
    host.db.prepare(`DELETE FROM journal_rows_data WHERE session_id = ?
AND epoch IS NOT (SELECT epoch FROM journal_sessions WHERE session_id = ?)`)
      .run(SESSION, 'unpublished-session')
    expect(host.db.prepare('SELECT COUNT(*) AS n FROM journal_text_pieces').get()?.n).toBe(0)
  })

  it('uses current required ancestors after separate reads prepare their Unicode suffixes', () => {
    const prefix = 'a'.repeat(255)
    const original = escapeJournalText(`${prefix}left`)
    const tail = '😀\0"\\\ud83d'
    const target = item(3, `${prefix}${tail}`)
    put(item(2, `${prefix}left`))
    put(target)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([target])
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([target])
    const rewrite = (suffix: string) =>
      host.db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE seq = 2').run(suffix)
    rewrite(`b${original.slice(1)}`)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2))
      .toEqual([item(3, `b${prefix.slice(1)}${tail}`)])
    const invalid = `\\q${original.slice(2)}`
    rewrite(invalid)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([])
    expect(replayJournal(host.db, SESSION)?.damage?.sequence).toBe(2)
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([])
    expect(host.db.prepare('SELECT suffix FROM journal_text_pieces WHERE seq = 2').get()?.suffix)
      .toBe(invalid)
    rewrite(original)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([target])
    host.db.prepare('DELETE FROM journal_text_pieces WHERE seq = 2').run()
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 2)).toEqual([])
  })

  it('bounds shared suffix retention and returns unchanged text after eviction or oversized input', () => {
    const db = host.db
    const first = prepareJournalTextSuffix(db, 'first', 0)
    expect(prepareJournalTextSuffix(db, 'first', 0)).toBe(first)
    for (let index = 0; index < 4096; index += 1) {
      prepareJournalTextSuffix(db, `suffix-${index}`, index % 256)
    }
    const evicted = prepareJournalTextSuffix(db, 'first', 0)
    expect(evicted).not.toBe(first)
    expect(evicted).toEqual(first)
    const large = 'x'.repeat(2 * 1024 * 1024)
    const charged = prepareJournalTextSuffix(db, large, 0)
    for (let alignment = 1; alignment <= 4; alignment += 1) {
      expect(prepareJournalTextSuffix(db, large, alignment)?.text).toBe(large)
    }
    expect(prepareJournalTextSuffix(db, large, 0)).not.toBe(charged)
    const oversized = 'y'.repeat(8 * 1024 * 1024)
    const uncached = prepareJournalTextSuffix(db, oversized, 255)
    expect(uncached?.text).toBe(oversized)
    expect(prepareJournalTextSuffix(db, oversized, 255)).not.toBe(uncached)
    put(item(2, 'first'))
    expect(readJournalRowsAfterCursor(db, SESSION, EPOCH, 1)).toEqual([item(2, 'first')])
    const beforeClose = prepareJournalTextSuffix(db, 'first', 0)
    const close = vi.spyOn(db, 'close').mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    expect(() => host.close()).toThrow('close failed')
    expect(host.db).toBe(db)
    expect(prepareJournalTextSuffix(db, 'first', 0)).not.toBe(beforeClose)
    expect(readJournalRowsAfterCursor(db, SESSION, EPOCH, 1)).toEqual([item(2, 'first')])
    close.mockRestore()
    host.close()
    host = JournalHostDatabase.open(root)
    expect(readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 1)).toEqual([item(2, 'first')])
  })
})

it.each(['raw', 'view'])('atomically upgrades schema 4 %s storage, rolls back before stamping and retries', (storageKind) => {
  const expected = readJournalRowsAfterCursor(host.db, SESSION, EPOCH, 0)
  host.close()
  const path = join(root, 'legacy.db')
  const legacy = storageKind === 'raw' ? new Database(path) : openJournalDatabase(path).db
  if (storageKind === 'raw') {
    legacy.exec(createJournalTablesSql())
  }
  publishJournalSessionEpoch(legacy, { sessionId: SESSION, workspaceId: 'ws' }, EPOCH)
  const final = item(3, 'legacy full text '.repeat(9))
  expected.push(item(2, 'legacy full text '.repeat(8)), final)
  for (const row of expected) {
    if (storageKind === 'raw') {
      legacy.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
        .run(SESSION, EPOCH, row.seq, row.ts, JSON.stringify(row))
    } else {
      insertJournalRow(legacy, SESSION, row)
    }
  }
  if (storageKind === 'view') {
    legacy.exec(`CREATE VIEW journal_rows AS
SELECT session_id, epoch, seq, ts, row_json FROM journal_rows_data`)
    for (const operation of ['insert', 'update', 'delete']) {
      legacy.exec(`CREATE TRIGGER journal_rows_compat_${operation} INSTEAD OF ${operation} ON journal_rows
BEGIN SELECT 1; END`)
    }
  }
  legacy.pragma('user_version = 4')
  const schema = legacy.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
  const table = storageKind === 'raw' ? 'journal_rows' : 'journal_rows_data'
  const physical = legacy.prepare(`SELECT * FROM ${table} ORDER BY seq`).all()
  const pieces = storageKind === 'raw' ? [] : legacy.prepare('SELECT * FROM journal_text_pieces ORDER BY seq').all()
  legacy.close()
  const original = Database.prototype.pragma
  const failure = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: Database.Database, sql: string, options?: { simple?: boolean }
  ) {
    if (sql === `user_version = ${JOURNAL_DB_SCHEMA_VERSION}`) {
      expect(this.prepare("SELECT name FROM sqlite_master WHERE name = 'journal_rows'").get()).toBeUndefined()
      throw new Error('migration interrupted before stamp')
    }
    return original.call(this, sql, options)
  })
  expect(() => openJournalDatabase(path)).toThrow('migration interrupted before stamp')
  failure.mockRestore()
  const rolledBack = new Database(path)
  expect(rolledBack.pragma('user_version', { simple: true })).toBe(4)
  expect(rolledBack.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
  expect(rolledBack.prepare(`SELECT * FROM ${table} ORDER BY seq`).all()).toEqual(physical)
  if (storageKind === 'view') {
    expect(rolledBack.prepare('SELECT * FROM journal_text_pieces ORDER BY seq').all()).toEqual(pieces)
  }
  rolledBack.close()
  for (let open = 0; open < 2; open += 1) {
    const { db } = openJournalDatabase(path)
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
      expect(db.prepare(`SELECT name FROM sqlite_master
WHERE name = 'journal_rows' OR name LIKE 'journal_rows_compat_%'`).all()).toEqual([])
      expect(readJournalRowsAfterCursor(db, SESSION, EPOCH, 0)).toEqual(expected)
      const replayed = replayJournal(db, SESSION)
      expect(replayed ? renderJournalState(replayed.state).items.at(-1)?.body : null).toEqual(final.body)
      if (storageKind === 'raw') {
        expect(db.prepare('SELECT row_json FROM journal_rows_data ORDER BY seq').all())
          .toEqual(physical.map(({ row_json }) => ({ row_json })))
      } else {
        expect(db.prepare('SELECT * FROM journal_rows_data ORDER BY seq').all()).toEqual(physical)
        expect(db.prepare('SELECT * FROM journal_text_pieces ORDER BY seq').all()).toEqual(pieces)
      }
      if (open === 1) {
        const continued = item(4, `${'legacy full text '.repeat(9)} continued`)
        insertJournalRow(db, SESSION, continued)
        expect(readJournalRowsAfterCursor(db, SESSION, EPOCH, 3)).toEqual([continued])
      }
    } finally {
      db.close()
    }
  }
})
