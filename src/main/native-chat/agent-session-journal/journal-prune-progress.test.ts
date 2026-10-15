import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type JournalTransaction
} from './journal-database'
import { JournalMaintenance } from './journal-maintenance'
import { replayJournal } from './journal-open'
import { JournalPrunePass } from './journal-prune-pass'
import { renderJournalState } from './journal-reducer'
import { insertJournalRow, publishJournalSessionEpoch } from './journal-row-table'

let root: string
let db: Database.Database
const transaction: JournalTransaction = (run, mode) =>
  runJournalTransaction(db, run, undefined, mode)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-prune-progress-'))
  db = openJournalDatabase(join(root, 'journal.db')).db
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  db.close()
  await rm(root, { recursive: true, force: true })
})

function start(sessionId = 'chat', epoch = 'epoch'): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'folder' }, epoch)
  insertJournalRow(db, sessionId, {
    v: 1,
    epoch,
    seq: 1,
    fence: 1,
    ts: 1,
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  })
}

function item(
  seq: number,
  itemId: string,
  revision: number,
  sessionId = 'chat',
  epoch = 'epoch',
  repeats = 10
): void {
  insertJournalRow(db, sessionId, {
    v: 1,
    epoch,
    seq,
    fence: 1,
    ts: seq,
    kind: 'item',
    itemId,
    revision,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: `revision ${revision} `.repeat(repeats) }]
    }
  })
}

function drain(sessionId = 'chat', epoch = 'epoch'): { scanned: number; compacted: number } {
  const pass = new JournalPrunePass(db, sessionId, epoch)
  let scanned = 0
  let compacted = 0
  for (let step = 0; step < 20_000; step++) {
    const result = pass.step(db, transaction)
    expect(result.scanned).toBeLessThanOrEqual(32)
    scanned += result.scanned
    compacted += result.compacted
    if (result.done) {
      return { scanned, compacted }
    }
  }
  throw new Error('journal pruning did not finish')
}

function snapshot(sessionId = 'chat') {
  return renderJournalState(replayJournal(db, sessionId)!.state)
}

function bodyAt(seq: number, sessionId = 'chat'): unknown {
  const json = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? AND seq = ?')
    .get(sessionId, seq)?.row_json
  const row: unknown = JSON.parse(String(json))
  return typeof row === 'object' && row !== null && 'body' in row ? row.body : undefined
}

it('reaches identities beyond the old admission cap without changing replay or sequence rows', () => {
  transaction(() => {
    start()
    for (let ordinal = 1; ordinal <= 16_384; ordinal++) {
      item(ordinal + 1, `earlier-${ordinal}`, 1)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(16_385 + revision, 'last', revision)
    }
  })
  const before = snapshot()
  expect(drain()).toEqual({ scanned: 16_388, compacted: 1 })
  expect(bodyAt(16_387)).toMatchObject({ blocks: [] })
  expect(snapshot()).toEqual(before)
  expect(db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS tip FROM journal_rows').get()).toEqual({
    n: 16_388,
    tip: 16_388
  })
})

it('continues only the appended suffix across lifecycle and tombstone boundaries', () => {
  transaction(() => {
    start()
    for (let ordinal = 1; ordinal <= 300; ordinal++) {
      item(ordinal + 1, `earlier-${ordinal}`, 1)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(301 + revision, 'old', revision)
    }
  })
  expect(drain()).toEqual({ scanned: 304, compacted: 1 })
  transaction(() => {
    item(305, 'old', 4)
    insertJournalRow(db, 'chat', {
      v: 1,
      epoch: 'epoch',
      seq: 306,
      fence: 1,
      ts: 306,
      kind: 'lifecycle-batch',
      settlementId: 'boundary',
      mutations: [
        {
          kind: 'item',
          itemId: 'old',
          revision: 5,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'boundary' }] }
        }
      ]
    })
    for (let revision = 6; revision <= 8; revision++) {
      item(301 + revision, 'old', revision)
    }
    for (let revision = 1; revision <= 3; revision++) {
      item(309 + revision, 'new', revision)
    }
    insertJournalRow(db, 'chat', {
      v: 1,
      epoch: 'epoch',
      seq: 313,
      fence: 1,
      ts: 313,
      kind: 'tombstone',
      itemId: 'new',
      revision: 4
    })
    for (let revision = 5; revision <= 7; revision++) {
      item(309 + revision, 'new', revision)
    }
  })
  const before = snapshot()
  expect(drain()).toEqual({ scanned: 12, compacted: 4 })
  expect(snapshot()).toEqual(before)
  for (const seq of [302, 305, 307, 309, 310, 312, 314, 316]) {
    expect(bodyAt(seq)).not.toMatchObject({ blocks: [] })
  }
  for (const seq of [303, 304, 308, 311, 315]) {
    expect(bodyAt(seq)).toMatchObject({ blocks: [] })
  }
  expect(drain()).toEqual({ scanned: 0, compacted: 0 })
})

it('finishes captured prefixes while appends preserve a later quiet-delay pass', async () => {
  transaction(() => {
    for (const session of ['a-active', 'b-quiet']) {
      start(session)
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, session)
      }
    }
  })
  vi.useFakeTimers()
  const maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.advanceTimersByTimeAsync(0)
    for (let seq = 5; seq <= 24; seq++) {
      transaction(() => item(seq, 'reply', seq - 1, 'a-active', 'epoch', 200))
      maintenance.appended('a-active')
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(bodyAt(3, 'a-active')).toMatchObject({ blocks: [] })
    expect(bodyAt(3, 'b-quiet')).toMatchObject({ blocks: [] })
    expect(bodyAt(5, 'a-active')).not.toMatchObject({ blocks: [] })
    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    const pagesBefore = Number(db.pragma('page_count', { simple: true }))
    const before = [snapshot('a-active'), snapshot('b-quiet')]
    const envelopes = () =>
      db
        .prepare(`SELECT session_id, epoch, seq, ts,
json_remove(row_json, '$.body') AS envelope FROM journal_rows ORDER BY session_id, seq`)
        .all()
    const retained = envelopes()
    await vi.runAllTimersAsync()
    expect(bodyAt(5, 'a-active')).toMatchObject({ blocks: [] })
    expect([snapshot('a-active'), snapshot('b-quiet')]).toEqual(before)
    expect(envelopes()).toEqual(retained)
    expect(db.pragma('freelist_count', { simple: true })).toBe(0)
    expect(Number(db.pragma('page_count', { simple: true }))).toBeLessThan(pagesBefore)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('schedules a replacement epoch even without an append notification', async () => {
  start()
  vi.useFakeTimers()
  const maintenance = new JournalMaintenance(() => db, transaction, 0)
  try {
    await vi.advanceTimersByTimeAsync(0)
    transaction(() => {
      db.prepare("DELETE FROM journal_rows WHERE session_id = 'chat'").run()
      start('chat', 'replacement')
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, 'chat', 'replacement')
      }
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(
      db.prepare('SELECT ready_at FROM temp.journal_prune_pending').get()?.ready_at
    ).toBeGreaterThan(Date.now())
    await vi.runAllTimersAsync()
    expect(bodyAt(3)).toMatchObject({ blocks: [] })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})

it('refuses an unknown suffix without rewriting it and continues healthy chats and new epochs', async () => {
  transaction(() => {
    start('a-bad')
    start('z-good')
    for (let revision = 1; revision <= 3; revision++) {
      item(revision + 1, 'reply', revision, 'a-bad')
      item(revision + 1, 'reply', revision, 'z-good')
    }
  })
  expect(drain('a-bad').compacted).toBe(1)
  transaction(() => {
    item(5, 'reply', 4, 'a-bad')
    item(6, 'reply', 5, 'a-bad')
    db.prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 999)
WHERE session_id = 'a-bad' AND seq = 6`).run()
  })
  const unchanged = db
    .prepare("SELECT row_json FROM journal_rows WHERE session_id = 'a-bad' ORDER BY seq")
    .all()
  vi.useFakeTimers()
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const maintenance = new JournalMaintenance(() => db, transaction)
  try {
    await vi.runAllTimersAsync()
    expect(
      db.prepare("SELECT row_json FROM journal_rows WHERE session_id = 'a-bad' ORDER BY seq").all()
    ).toEqual(unchanged)
    expect(bodyAt(3, 'z-good')).toMatchObject({ blocks: [] })
    expect(warned).toHaveBeenCalledTimes(1)
    maintenance.appended('a-bad')
    await vi.runAllTimersAsync()
    expect(warned).toHaveBeenCalledTimes(1)
    transaction(() => {
      db.prepare("DELETE FROM journal_rows WHERE session_id = 'a-bad'").run()
      start('a-bad', 'replacement')
      for (let revision = 1; revision <= 3; revision++) {
        item(revision + 1, 'reply', revision, 'a-bad', 'replacement')
      }
    })
    maintenance.appended('a-bad')
    await vi.runAllTimersAsync()
    expect(bodyAt(3, 'a-bad')).toMatchObject({ blocks: [] })
    expect(
      db.prepare("SELECT epoch FROM temp.journal_prune_epochs WHERE session_id = 'a-bad'").all()
    ).toEqual([{ epoch: 'replacement' }])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    maintenance.close()
  }
})
