import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { moveTableShape, readMoveTables, type MoveTable } from './database-move-catalog.js'
import { logMoveEvent, MoveRefusal, sleep } from './database-move-events.js'
import {
  addReferencedParents,
  applyMoveChanges,
  readSourceRows,
  type MoveChanges,
  type MoveKey
} from './database-move-row-apply.js'
import {
  markSourceDirty,
  MOVE_CLAIMED_TABLE,
  MOVE_DIRTY_TABLE,
  MOVE_COPY_PROGRESS_TABLE,
  MOVE_SENTINEL_TABLE_NAME,
  readDirtyBacklog,
  readAuthorityTrackingArm,
  readCurrentCopiedTables,
  readStaleCopyProgress,
  readTrackingArm,
  readTrackingState,
  sentinelPresent
} from './database-move-tracking.js'

// A director boot can add a column mid-run; rows copied without it would silently drop it.
export const MOVE_SCHEMA_CHECK_EVERY_MS = 30_000

// One syncer per source: the claimed journal is replayed on start, which is only safe when no
// other syncer is mid-batch. The cutover takes the same lock.
const SYNC_LOCK_KEYS = [0x6f72_6361, 0x6d6f_7665] as const

export type MoveSyncSessions = {
  // Both as the tool role, so neither the claim nor the apply marks anything dirty.
  source: pg.Client
  target: pg.Client
}

export type MoveBatchResult = { keys: number; upserted: number; deleted: number; displaced: number }

export async function takeSyncLock(source: pg.Client): Promise<void> {
  const result = await source.query(`SELECT pg_try_advisory_lock($1, $2) AS taken`, [
    ...SYNC_LOCK_KEYS
  ])
  if (!result.rows[0]?.taken) throw new MoveRefusal('another_sync_is_running')
}

export async function requireSentinel(source: pg.Client): Promise<void> {
  if (!(await sentinelPresent(source))) {
    throw new MoveRefusal('dirty_set_was_emptied_recopy_needed')
  }
}

// Every source table must still carry its triggers: a key changed on one without them is lost.
export async function requireTracking(source: pg.Client, tables: MoveTable[]): Promise<void> {
  const state = await readTrackingState(source, tables)
  if (!state.sentinel) throw new MoveRefusal('dirty_set_was_emptied_recopy_needed')
  if (state.untracked.length > 0) {
    throw new MoveRefusal('tables_without_tracking', { tables: state.untracked })
  }
}

// Tracking that was removed and installed again missed every change in between, so a copy
// made under the earlier arming no longer counts. Applying changes (sync, cutover) also needs the
// target to be level with the source as a whole: a finished copy under this arming, or this
// arming unchanged since the source itself became the target (a move back after a cutover).
export async function requireCurrentCopy(
  sessions: MoveSyncSessions,
  tables: MoveTable[],
  purpose: 'copy' | 'apply'
): Promise<void> {
  const arm = await readTrackingArm(sessions.source)
  const stale = await readStaleCopyProgress(sessions.target, arm)
  if (stale.length > 0) {
    throw new MoveRefusal('copy_predates_tracking', { tables: stale, run: 'copy --restart' })
  }
  if (purpose === 'copy') return
  const copied = await readCurrentCopiedTables(sessions.target, arm)
  if (tables.every((table) => copied.has(table.name))) return
  if (arm !== null && (await readAuthorityTrackingArm(sessions.source)) === arm) return
  throw new MoveRefusal('target_not_current', {
    uncopied: tables.filter((table) => !copied.has(table.name)).map((table) => table.name),
    run: 'copy --restart from this source'
  })
}

// Both sides still have the tables the run started with. A drifted table's copy position is
// reset, because rows already copied may lack a column.
export async function requireUnchangedMoveState(
  sessions: MoveSyncSessions,
  tables: MoveTable[]
): Promise<void> {
  const [source, target] = await Promise.all([
    readMoveTables(sessions.source),
    readMoveTables(sessions.target)
  ])
  const started = new Map(tables.map((table) => [table.name, moveTableShape(table)]))
  const targetShapes = new Map(target.map((table) => [table.name, moveTableShape(table)]))
  const drifted = source
    .filter((table) => {
      const shape = moveTableShape(table)
      return started.get(table.name) !== shape || targetShapes.get(table.name) !== shape
    })
    .map((table) => table.name)
  if (drifted.length > 0) {
    await sessions.target.query(
      `DELETE FROM ${MOVE_COPY_PROGRESS_TABLE} WHERE table_name = ANY($1)`,
      [drifted]
    )
    throw new MoveRefusal('schema_changed_during_run', {
      tables: drifted,
      copyProgressReset: true,
      run: 'prepare-target, then copy and sync again'
    })
  }
  await requireTracking(sessions.source, tables)
}

// Reads every claimed key's current source row in one snapshot, then applies the lot in one
// target transaction. The claim is dropped only after the target commits.
async function applyKeys(
  sessions: MoveSyncSessions,
  tables: MoveTable[],
  keys: MoveKey[],
  claimId: string
): Promise<MoveBatchResult> {
  const changes: MoveChanges = new Map()
  const known = new Map(tables.map((table) => [table.name, table]))
  await sessions.source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    for (const table of tables) {
      const pks = keys.filter((key) => key.table === table.name).map((key) => key.pk)
      if (pks.length > 0) await readSourceRows(sessions.source, table, pks, changes)
    }
    await addReferencedParents(sessions.source, tables, changes)
    await sessions.source.query('COMMIT')
  } catch (error) {
    await sessions.source.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  const unknown = keys.filter((key) => !known.has(key.table)).length
  if (unknown > 0) logMoveEvent('sync_unknown_table_keys', { keys: unknown })
  await sessions.target.query('BEGIN')
  let applied: Omit<MoveBatchResult, 'keys'>
  try {
    applied = await applyMoveChanges(sessions.target, tables, changes, (displaced) =>
      markSourceDirty(sessions.source, displaced)
    )
    await sessions.target.query('COMMIT')
  } catch (error) {
    await sessions.target.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  await sessions.source.query(`DELETE FROM ${MOVE_CLAIMED_TABLE} WHERE claim_id = $1`, [claimId])
  return { keys: keys.length, ...applied }
}

function claimedKeys(rows: Array<Record<string, unknown>>): MoveKey[] {
  return rows.map((row) => ({ table: String(row.table_name), pk: String(row.pk) }))
}

// Claims run as their own committed statement, so the claim's row locks are held for one
// statement only: writers marking the same key wait at most that long.
export async function syncBatch(
  sessions: MoveSyncSessions,
  tables: MoveTable[],
  batchKeys: number
): Promise<MoveBatchResult> {
  const claimId = randomUUID()
  const claimed = await sessions.source.query(
    `WITH taken AS (
       DELETE FROM ${MOVE_DIRTY_TABLE}
       WHERE (table_name, pk) IN (
         SELECT table_name, pk FROM ${MOVE_DIRTY_TABLE} WHERE table_name <> $2
         LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING table_name, pk)
     INSERT INTO ${MOVE_CLAIMED_TABLE} (claim_id, table_name, pk)
     SELECT $1, table_name, pk FROM taken
     RETURNING table_name, pk::text AS pk`,
    [claimId, MOVE_SENTINEL_TABLE_NAME, batchKeys]
  )
  if (claimed.rows.length === 0) return { keys: 0, upserted: 0, deleted: 0, displaced: 0 }
  return await applyKeys(sessions, tables, claimedKeys(claimed.rows), claimId)
}

// Claims left by a syncer that died between its claim and its apply.
export async function replayClaims(
  sessions: MoveSyncSessions,
  tables: MoveTable[]
): Promise<number> {
  let replayed = 0
  for (;;) {
    const next = await sessions.source.query(`SELECT claim_id FROM ${MOVE_CLAIMED_TABLE} LIMIT 1`)
    const claimId = next.rows[0]?.claim_id
    if (claimId === undefined) return replayed
    const keys = await sessions.source.query(
      `SELECT table_name, pk::text AS pk FROM ${MOVE_CLAIMED_TABLE} WHERE claim_id = $1`,
      [claimId]
    )
    replayed += (await applyKeys(sessions, tables, claimedKeys(keys.rows), String(claimId))).keys
  }
}

export type MoveSyncOptions = {
  batchKeys?: number
  idleMs?: number
  reportEveryMs?: number
  // Stop once the backlog is at most this (0 = empty, nothing held); otherwise run until stopped.
  stopAtBacklog?: number
  // The cutover drains with a hard deadline (epoch ms).
  deadline?: number
  shouldStop?: () => boolean
  label?: Record<string, unknown>
  schemaCheckEveryMs?: number
}

// Keys a writer holds are skipped (SKIP LOCKED) and stay in the backlog, so a drain to 0 also
// waits out every open writer.
export async function runSyncLoop(
  sessions: MoveSyncSessions,
  tables: MoveTable[],
  options: MoveSyncOptions = {}
): Promise<{ keys: number; batches: number }> {
  const batchKeys = options.batchKeys ?? 500
  const idleMs = options.idleMs ?? 200
  const reportEveryMs = options.reportEveryMs ?? 10_000
  let keys = 0
  let batches = 0
  let lastEmptyAt = Date.now()
  let lastReportAt = 0
  let lastLoopMs = 0
  let windowKeys = 0
  let schemaCheckedAt = Date.now()
  for (;;) {
    if (options.shouldStop?.()) return { keys, batches }
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      throw new MoveRefusal('sync_deadline_passed', { keys })
    }
    if (
      Date.now() - schemaCheckedAt >=
      (options.schemaCheckEveryMs ?? MOVE_SCHEMA_CHECK_EVERY_MS)
    ) {
      await requireUnchangedMoveState(sessions, tables)
      schemaCheckedAt = Date.now()
    }
    await requireSentinel(sessions.source)
    const startedAt = Date.now()
    const result = await syncBatch(sessions, tables, batchKeys)
    lastLoopMs = Date.now() - startedAt
    keys += result.keys
    windowKeys += result.keys
    if (result.keys > 0) batches += 1
    const now = Date.now()
    const report = now - lastReportAt >= reportEveryMs
    // Between reports, count only far enough to decide, so a big backlog stays a cheap read.
    const backlog = report
      ? await readDirtyBacklog(sessions.source)
      : result.keys === 0 || options.stopAtBacklog !== undefined
        ? await readDirtyBacklog(sessions.source, (options.stopAtBacklog ?? 0) + 1)
        : null
    if (backlog === 0) lastEmptyAt = now
    if (report) {
      logMoveEvent('sync_progress', {
        ...options.label,
        backlog,
        keysPerSecond: Math.round(
          (windowKeys * 1000) / Math.max(1, now - (lastReportAt || startedAt))
        ),
        loopMs: lastLoopMs,
        behindMs: backlog === 0 ? 0 : now - lastEmptyAt
      })
      lastReportAt = now
      windowKeys = 0
    }
    if (
      options.stopAtBacklog !== undefined &&
      backlog !== null &&
      backlog <= options.stopAtBacklog
    ) {
      return { keys, batches }
    }
    if (result.keys === 0) await sleep(backlog === 0 ? idleMs : Math.min(idleMs, 20))
  }
}
