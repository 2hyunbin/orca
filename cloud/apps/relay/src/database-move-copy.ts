import type { MoveTable } from './database-move-catalog.js'
import { logMoveEvent, sleep } from './database-move-events.js'
import {
  addReferencedParents,
  addTargetStrays,
  applyMoveChanges,
  readSourcePage,
  type MoveChanges
} from './database-move-row-apply.js'
import { requireSentinel, type MoveSyncSessions } from './database-move-sync.js'
import {
  markSourceDirty,
  MOVE_COPY_PROGRESS_TABLE,
  sentinelInsertSql
} from './database-move-tracking.js'

// ~1 GB/h: well under the 7-20 GB/h the shared instance already reads, so the copy adds little
// to its cache churn.
export const DEFAULT_COPY_BYTES_PER_SECOND = 300_000

export type MoveCopyOptions = {
  batchRows?: number
  maxBytesPerSecond?: number
  // Forget the saved position and start every table again; also re-arms an emptied dirty set.
  restart?: boolean
  // Checked between pages; the saved position makes the next run resume.
  shouldStop?: () => boolean
}

// Every table in parent-first order, in primary-key pages; each page also deletes target rows in
// its key range that the source no longer has. The position is saved on the target in
// the same transaction as the rows, so a stopped copy resumes exactly where it committed. Rows
// that change behind the copy are on the dirty set, which the sync replays. The caller holds the
// sync lock: a sync applying a key between this page's read and its write would be overwritten
// with the older row, and the key would already be off the dirty set.
export async function runCopy(
  sessions: MoveSyncSessions,
  tables: MoveTable[],
  options: MoveCopyOptions = {}
): Promise<{ rows: number; bytes: number; stopped: boolean }> {
  const batchRows = options.batchRows ?? 500
  const maxBytesPerSecond = options.maxBytesPerSecond ?? DEFAULT_COPY_BYTES_PER_SECOND
  if (options.restart) {
    // Armed before the first page: every change from here on is either copied or dirty.
    await sessions.source.query(sentinelInsertSql())
    await sessions.target.query(`DELETE FROM ${MOVE_COPY_PROGRESS_TABLE}`)
    logMoveEvent('copy_restarted')
  }
  await requireSentinel(sessions.source)
  const startedAt = Date.now()
  let bytes = 0
  let rows = 0
  for (const table of tables) {
    const saved = await sessions.target.query(
      `SELECT after_pk::text AS after_pk, done, rows_copied::text AS rows_copied
       FROM ${MOVE_COPY_PROGRESS_TABLE} WHERE table_name = $1`,
      [table.name]
    )
    if (saved.rows[0]?.done) continue
    let afterPk: string | null = saved.rows[0]?.after_pk ?? null
    let tableRows = Number(saved.rows[0]?.rows_copied ?? 0)
    logMoveEvent('copy_table_started', { table: table.name, resumed: afterPk !== null })
    for (;;) {
      if (options.shouldStop?.()) {
        logMoveEvent('copy_stopped', { table: table.name, rows })
        return { rows, bytes, stopped: true }
      }
      const changes: MoveChanges = new Map()
      await sessions.source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      let page: Awaited<ReturnType<typeof readSourcePage>>
      try {
        page = await readSourcePage(sessions.source, table, afterPk, batchRows, changes)
        bytes += page.bytes + (await addReferencedParents(sessions.source, tables, changes))
        await sessions.source.query('COMMIT')
      } catch (error) {
        await sessions.source.query('ROLLBACK').catch(() => undefined)
        throw error
      }
      const done = page.rows < batchRows
      const range = { after: afterPk, through: done ? null : page.lastPk, pagePks: page.pks }
      afterPk = page.lastPk ?? afterPk
      tableRows += page.rows
      await sessions.target.query('BEGIN')
      try {
        await addTargetStrays(sessions.target, table, range, changes)
        await applyMoveChanges(sessions.target, tables, changes, (displaced) =>
          markSourceDirty(sessions.source, displaced)
        )
        await sessions.target.query(
          `INSERT INTO ${MOVE_COPY_PROGRESS_TABLE} (table_name, after_pk, done, rows_copied, updated_at)
           VALUES ($1, $2::jsonb, $3, $4, $5)
           ON CONFLICT (table_name) DO UPDATE SET after_pk = EXCLUDED.after_pk, done = EXCLUDED.done,
             rows_copied = EXCLUDED.rows_copied, updated_at = EXCLUDED.updated_at`,
          [table.name, afterPk, done, tableRows, Date.now()]
        )
        await sessions.target.query('COMMIT')
      } catch (error) {
        await sessions.target.query('ROLLBACK').catch(() => undefined)
        throw error
      }
      rows += page.rows
      // Paced on bytes read: sleep until the running average is back under the limit.
      await sleep((bytes * 1000) / maxBytesPerSecond - (Date.now() - startedAt))
      if (done) break
    }
    logMoveEvent('copy_table_done', { table: table.name, rows: tableRows })
  }
  logMoveEvent('copy_done', { rows, bytes, ms: Date.now() - startedAt })
  return { rows, bytes, stopped: false }
}
