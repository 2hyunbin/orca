import { serialize } from 'node:v8'
import { expect } from 'vitest'
import type { JournalStructuralScratch } from './journal-structural-scratch'
import type { JournalHostDatabase } from './journal-host-database'
import { readJournalSessionProjection } from './journal-row-table'

export function assertPopulationQueryPlans(
  reader: JournalStructuralScratch,
  database: JournalHostDatabase,
  sessionId: string
): void {
  const pointPlan = reader.db
    .prepare(`EXPLAIN QUERY PLAN SELECT value FROM relations
      WHERE space = ? AND key = ?`)
    .all(serialize('selection:treeNodes'), serialize('node'))
  expect(pointPlan.map((row) => String(row.detail)).join(' ')).toMatch(/SEARCH.*INDEX.*space.*key/i)
  const rangePlan = reader.db
    .prepare(`EXPLAIN QUERY PLAN SELECT id,key,value FROM relations
      WHERE space = ? AND id > ? ORDER BY id LIMIT 1`)
    .all(serialize('items'), 0)
  expect(rangePlan.map((row) => String(row.detail)).join(' ')).toMatch(/relation_cursor/i)

  const cleanupPlan = reader.db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM relations
      ORDER BY id LIMIT ?`)
    .all(32)
  expect(cleanupPlan.map((row) => String(row.detail)).join(' ')).toMatch(/SCAN relations/i)
  expect(cleanupPlan.map((row) => String(row.detail)).join(' ')).not.toMatch(/TEMP B-TREE/i)
  const clearCleanupPlan = reader.db
    .prepare(`EXPLAIN QUERY PLAN SELECT key FROM context_clears
      ORDER BY key LIMIT ?`)
    .all(32)
  expect(clearCleanupPlan.map((row) => String(row.detail)).join(' ')).toMatch(
    /SCAN context_clears USING COVERING INDEX sqlite_autoindex_context_clears_1/i
  )
  expect(clearCleanupPlan.map((row) => String(row.detail)).join(' ')).not.toMatch(/TEMP B-TREE/i)
  const tipPlan = database.db
    .prepare(`EXPLAIN QUERY PLAN SELECT MAX(seq) AS tip FROM journal_rows
      WHERE session_id = ? AND epoch = ?`)
    .all(sessionId, readJournalSessionProjection(database.db, sessionId)!.epoch)
  expect(tipPlan.map((row) => String(row.detail)).join(' ')).toMatch(
    /SEARCH.*COVERING INDEX.*session_id.*epoch/i
  )
  const coveredCursor = reader.db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM relations
      WHERE space = ? AND id > ? ORDER BY id LIMIT 1`)
    .all(serialize('items'), 0)
  expect(coveredCursor.map((row) => String(row.detail)).join(' ')).toMatch(
    /SEARCH.*COVERING INDEX relation_cursor.*space.*id/i
  )
  const deletePlan = reader.db
    .prepare('EXPLAIN QUERY PLAN DELETE FROM relations WHERE id = ?')
    .all(1)
  expect(deletePlan.map((row) => String(row.detail)).join(' ')).toMatch(
    /SEARCH relations USING INTEGER PRIMARY KEY/i
  )
  const clearDelete = reader.db
    .prepare('EXPLAIN QUERY PLAN DELETE FROM context_clears WHERE key = ?')
    .all(serialize('clear'))
  expect(clearDelete.map((row) => String(row.detail)).join(' ')).toMatch(
    /SEARCH context_clears USING INDEX sqlite_autoindex_context_clears_1.*key/i
  )
  const hostCursor = database.db
    .prepare(`EXPLAIN QUERY PLAN SELECT row_json FROM journal_rows
      WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC LIMIT 32`)
    .all(sessionId, readJournalSessionProjection(database.db, sessionId)!.epoch, 0)
  expect(hostCursor.map((row) => String(row.detail)).join(' ')).toMatch(
    /SEARCH.*INDEX.*session_id.*epoch.*seq/i
  )
  expect(hostCursor.map((row) => String(row.detail)).join(' ')).not.toMatch(/TEMP B-TREE/i)
}
