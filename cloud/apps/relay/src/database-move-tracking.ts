import type pg from 'pg'
import {
  pkJson,
  quoteIdent,
  quoteLiteral,
  RELAY_DATABASE_AUTHORITY_TABLE,
  tableRef,
  type MoveTable
} from './database-move-catalog.js'
import { logMoveEvent, MoveRefusal, sleep } from './database-move-events.js'

// Unlogged: no WAL, nothing in the shared instance's archive. A crash or failover empties it,
// sentinel included, and the sentinel's absence is how the sync knows keys were lost.
export const MOVE_DIRTY_TABLE = 'relay_move_dirty'
// Keys a sync has taken off the dirty set but not yet applied; replayed after a crash.
export const MOVE_CLAIMED_TABLE = 'relay_move_claimed'
export const MOVE_COPY_PROGRESS_TABLE = 'relay_move_copy_progress'
export const MOVE_SENTINEL_TABLE_NAME = 'relay_move_sentinel'

const TRIGGER_PREFIX = 'relay_move_track_'
const TRUNCATE_FUNCTION = 'relay_move_truncated'
const TRIGGERS = ['ins', 'upd', 'del', 'trunc'] as const
const POSTGRES_NAME_MAX_BYTES = 63
const LOCK_NOT_AVAILABLE = '55P03'

// Missing table or row = 0, as the relay reads it.
export async function readAuthorityGeneration(client: pg.Client): Promise<number> {
  try {
    const result = await client.query(
      `SELECT generation::text AS generation FROM ${RELAY_DATABASE_AUTHORITY_TABLE}`
    )
    return Number(result.rows[0]?.generation ?? 0)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
      return 0
    throw error
  }
}

export type TrackingConflictAction = 'update' | 'nothing'

export const AUTHORITY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${RELAY_DATABASE_AUTHORITY_TABLE} (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation BIGINT NOT NULL,
  written_at BIGINT NOT NULL
)`

// The move tool's own column, which the relay never reads: this side's tracking arming when it
// became the target, so a move back can tell whether the copy kept in step since.
const AUTHORITY_MOVE_COLUMNS_SQL = [
  `ALTER TABLE ${RELAY_DATABASE_AUTHORITY_TABLE} ADD COLUMN IF NOT EXISTS tracking_arm TEXT`
]

const MOVE_TABLES_SQL = [
  `CREATE UNLOGGED TABLE IF NOT EXISTS ${MOVE_CLAIMED_TABLE} (
     claim_id TEXT NOT NULL, table_name TEXT NOT NULL, pk JSONB NOT NULL,
     PRIMARY KEY (claim_id, table_name, pk))`,
  `CREATE TABLE IF NOT EXISTS ${MOVE_COPY_PROGRESS_TABLE} (
     table_name TEXT PRIMARY KEY, after_pk JSONB, done BOOLEAN NOT NULL DEFAULT FALSE,
     rows_copied BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL)`,
  // Which arming of the source's tracking the copy ran under; see readTrackingArm.
  `ALTER TABLE ${MOVE_COPY_PROGRESS_TABLE} ADD COLUMN IF NOT EXISTS tracking_arm TEXT`
]

function trackingFunctionName(table: MoveTable): string {
  const name = `${TRIGGER_PREFIX}${table.name}`
  if (Buffer.byteLength(name) > POSTGRES_NAME_MAX_BYTES) {
    throw new MoveRefusal('table_name_too_long_for_tracking', { table: table.name })
  }
  return name
}

// DO UPDATE, never DO NOTHING: the row lock it takes on an existing dirty key makes the sync's
// SKIP LOCKED take pass that key until this writer commits, so a change committed after the
// sync read the row is never lost with the key.
export function trackingFunctionSql(
  table: MoveTable,
  toolUser: string,
  conflictAction: TrackingConflictAction = 'update'
): string {
  const mark = (source: string): string => `
    INSERT INTO ${MOVE_DIRTY_TABLE} (table_name, pk, touched)
    SELECT ${quoteLiteral(table.name)}, ${pkJson(table, 'k')}, 1 FROM (${source}) k
    ON CONFLICT (table_name, pk) DO ${
      conflictAction === 'update'
        ? `UPDATE SET touched = ${MOVE_DIRTY_TABLE}.touched + 1`
        : 'NOTHING'
    };`
  const columns = table.primaryKey.map((column) => quoteIdent(column)).join(', ')
  return `CREATE OR REPLACE FUNCTION public.${quoteIdent(trackingFunctionName(table))}()
RETURNS trigger LANGUAGE plpgsql AS $relay_move$
BEGIN
  IF current_user = ${quoteLiteral(toolUser)} THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN${mark(`SELECT ${columns} FROM relay_move_new`)}
  ELSIF TG_OP = 'UPDATE' THEN${mark(
    `SELECT ${columns} FROM relay_move_new UNION SELECT ${columns} FROM relay_move_old`
  )}
  ELSE${mark(`SELECT ${columns} FROM relay_move_old`)}
  END IF;
  RETURN NULL;
END $relay_move$`
}

function triggerStatements(table: MoveTable): string[] {
  const fn = `public.${quoteIdent(trackingFunctionName(table))}()`
  const on = tableRef(table)
  return [
    ...TRIGGERS.map((suffix) => `DROP TRIGGER IF EXISTS ${TRIGGER_PREFIX}${suffix} ON ${on}`),
    `CREATE TRIGGER ${TRIGGER_PREFIX}ins AFTER INSERT ON ${on}
       REFERENCING NEW TABLE AS relay_move_new FOR EACH STATEMENT EXECUTE FUNCTION ${fn}`,
    `CREATE TRIGGER ${TRIGGER_PREFIX}upd AFTER UPDATE ON ${on}
       REFERENCING OLD TABLE AS relay_move_old NEW TABLE AS relay_move_new
       FOR EACH STATEMENT EXECUTE FUNCTION ${fn}`,
    `CREATE TRIGGER ${TRIGGER_PREFIX}del AFTER DELETE ON ${on}
       REFERENCING OLD TABLE AS relay_move_old FOR EACH STATEMENT EXECUTE FUNCTION ${fn}`,
    // A truncate cannot be listed key by key, so it voids the dirty set as a failover would.
    `CREATE TRIGGER ${TRIGGER_PREFIX}trunc AFTER TRUNCATE ON ${on}
       FOR EACH STATEMENT EXECUTE FUNCTION public.${TRUNCATE_FUNCTION}()`
  ]
}

// Each table's DDL is one short transaction under a 200 ms lock wait, so a writer queued behind
// it waits at most that long; a timeout backs off and retries.
async function withShortLocks(
  client: pg.Client,
  label: string,
  statements: string[],
  attempts: number
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '200ms'`)
      for (const statement of statements) await client.query(statement)
      await client.query('COMMIT')
      return
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null
      if (code !== LOCK_NOT_AVAILABLE || attempt >= attempts) throw error
      logMoveEvent('lock_retry', { object: label, attempt })
      await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000) * (0.5 + Math.random() / 2))
    }
  }
}

// The tool role reads and writes relay rows and the move's own tables; it owns nothing.
export async function grantMoveRole(
  client: pg.Client,
  toolUser: string,
  tables: MoveTable[],
  attempts = 25
): Promise<void> {
  const role = quoteIdent(toolUser)
  const statements = [
    ...tables.map(
      (table) => `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableRef(table)} TO ${role}`
    ),
    `GRANT SELECT, INSERT, UPDATE ON ${RELAY_DATABASE_AUTHORITY_TABLE} TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${MOVE_CLAIMED_TABLE}, ${MOVE_COPY_PROGRESS_TABLE} TO ${role}`
  ]
  if (await dirtyTableExists(client)) {
    // The trigger writes the dirty set as whichever role changed the row, so every role that
    // may write relay rows needs it too, or tracking would fail that role's writes.
    const writers = await client.query(
      `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS role
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
         AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> c.relowner`,
      [tables.map((table) => table.name)]
    )
    const grantees = new Set([role, ...writers.rows.map((row) => String(row.role))])
    if (grantees.size > 1) logMoveEvent('tracking_writer_roles', { roles: [...grantees] })
    statements.push(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${MOVE_DIRTY_TABLE} TO ${[...grantees].join(', ')}`
    )
  }
  for (const statement of statements) await withShortLocks(client, 'grant', [statement], attempts)
}

// The move's own tables that exist on both sides whether or not tracking is on.
export async function createMoveBookkeeping(client: pg.Client, attempts = 25): Promise<void> {
  for (const statement of [
    AUTHORITY_TABLE_SQL,
    ...AUTHORITY_MOVE_COLUMNS_SQL,
    ...MOVE_TABLES_SQL
  ]) {
    await withShortLocks(client, 'bookkeeping', [statement], attempts)
  }
}

export async function installTracking(
  client: pg.Client,
  input: {
    toolUser: string
    tables: MoveTable[]
    attempts?: number
    conflictAction?: TrackingConflictAction
  }
): Promise<{ sentinel: 'armed' | 'present' | 'missing' }> {
  const attempts = input.attempts ?? 25
  await createMoveBookkeeping(client, attempts)
  const existed = await dirtyTableExists(client)
  // A table left without triggers (an interrupted untrack) missed changes: start a new arming,
  // which voids every copy made under the old one.
  const partial = existed && (await readTrackingState(client, input.tables)).untracked.length > 0
  if (partial && (await sentinelPresent(client))) {
    await client.query(`DELETE FROM ${MOVE_DIRTY_TABLE} WHERE table_name = $1`, [
      MOVE_SENTINEL_TABLE_NAME
    ])
    await client.query(sentinelInsertSql())
    logMoveEvent('tracking_rearmed', { reason: 'tables_without_triggers' })
  }
  // The sentinel is armed only with a new table: re-arming an emptied one would hide lost keys.
  await withShortLocks(
    client,
    MOVE_DIRTY_TABLE,
    [
      `CREATE UNLOGGED TABLE IF NOT EXISTS ${MOVE_DIRTY_TABLE} (
         table_name TEXT NOT NULL, pk JSONB NOT NULL, touched BIGINT NOT NULL,
         PRIMARY KEY (table_name, pk))`,
      ...(existed ? [] : [sentinelInsertSql()]),
      `CREATE OR REPLACE FUNCTION public.${TRUNCATE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS
       $relay_move$ BEGIN
         DELETE FROM ${MOVE_DIRTY_TABLE} WHERE table_name = ${quoteLiteral(MOVE_SENTINEL_TABLE_NAME)};
         RETURN NULL;
       END $relay_move$`
    ],
    attempts
  )
  await grantMoveRole(client, input.toolUser, input.tables, attempts)
  for (const table of input.tables) {
    await withShortLocks(
      client,
      table.name,
      [
        trackingFunctionSql(table, input.toolUser, input.conflictAction),
        ...triggerStatements(table)
      ],
      attempts
    )
    logMoveEvent('tracking_installed', { table: table.name })
  }
  const sentinel = existed ? ((await sentinelPresent(client)) ? 'present' : 'missing') : 'armed'
  return { sentinel }
}

export async function uninstallTracking(
  client: pg.Client,
  tables: MoveTable[],
  attempts = 25
): Promise<void> {
  // First and committed on its own: an untrack that stops partway leaves no arming behind for a
  // later install to keep.
  if (await dirtyTableExists(client)) {
    await client.query(`DELETE FROM ${MOVE_DIRTY_TABLE} WHERE table_name = $1`, [
      MOVE_SENTINEL_TABLE_NAME
    ])
  }
  for (const table of tables) {
    await withShortLocks(
      client,
      table.name,
      [
        ...TRIGGERS.map(
          (suffix) => `DROP TRIGGER IF EXISTS ${TRIGGER_PREFIX}${suffix} ON ${tableRef(table)}`
        ),
        `DROP FUNCTION IF EXISTS public.${quoteIdent(trackingFunctionName(table))}()`
      ],
      attempts
    )
    logMoveEvent('tracking_removed', { table: table.name })
  }
  await withShortLocks(
    client,
    MOVE_DIRTY_TABLE,
    [
      `DROP FUNCTION IF EXISTS public.${TRUNCATE_FUNCTION}()`,
      `DROP TABLE IF EXISTS ${MOVE_DIRTY_TABLE}, ${MOVE_CLAIMED_TABLE}`
    ],
    attempts
  )
}

// Each arming gets a fresh id in the sentinel's key. Rows copied under an earlier arming may
// have missed changes made while tracking was off, so a copy is current only under this id.
export function sentinelInsertSql(): string {
  const sentinel = quoteLiteral(MOVE_SENTINEL_TABLE_NAME)
  return `INSERT INTO ${MOVE_DIRTY_TABLE} (table_name, pk, touched)
    SELECT ${sentinel}, jsonb_build_object('arm', gen_random_uuid()::text), 0
    WHERE NOT EXISTS (SELECT 1 FROM ${MOVE_DIRTY_TABLE} WHERE table_name = ${sentinel})`
}

// The current arming's id; '' for a sentinel armed before ids existed, null with none.
export async function readTrackingArm(client: pg.Client): Promise<string | null> {
  if (!(await dirtyTableExists(client))) return null
  const result = await client.query(
    `SELECT coalesce(pk->>'arm', '') AS arm FROM ${MOVE_DIRTY_TABLE} WHERE table_name = $1 LIMIT 1`,
    [MOVE_SENTINEL_TABLE_NAME]
  )
  const arm = result.rows[0]?.arm
  return arm === undefined ? null : String(arm)
}

// The arming recorded when this side last became the target; null if it never was.
export async function readAuthorityTrackingArm(client: pg.Client): Promise<string | null> {
  const result = await client
    .query(`SELECT tracking_arm FROM ${RELAY_DATABASE_AUTHORITY_TABLE}`)
    .catch((error: unknown) => {
      // 42P01/42703: never prepared, or prepared before the column existed.
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null
      if (code === '42P01' || code === '42703') return null
      throw error
    })
  const arm = result?.rows[0]?.tracking_arm
  return typeof arm === 'string' ? arm : null
}

// Tables with a finished copy position under this arming.
export async function readCurrentCopiedTables(
  target: pg.Client,
  sourceArm: string | null
): Promise<Set<string>> {
  const result = await target.query(
    `SELECT table_name FROM ${MOVE_COPY_PROGRESS_TABLE} WHERE done AND tracking_arm = $1`,
    [sourceArm]
  )
  return new Set(result.rows.map((row) => String(row.table_name)))
}

// Copy positions on the target written under another arming of the source's tracking.
export async function readStaleCopyProgress(
  target: pg.Client,
  sourceArm: string | null
): Promise<string[]> {
  const result = await target.query(
    `SELECT table_name FROM ${MOVE_COPY_PROGRESS_TABLE}
     WHERE tracking_arm IS DISTINCT FROM $1 ORDER BY table_name`,
    [sourceArm]
  )
  return result.rows.map((row) => String(row.table_name))
}

// False with no dirty table too: tracking was never installed, or was removed.
export async function sentinelPresent(client: pg.Client): Promise<boolean> {
  if (!(await dirtyTableExists(client))) return false
  const result = await client.query(
    `SELECT EXISTS (SELECT 1 FROM ${MOVE_DIRTY_TABLE} WHERE table_name = $1) AS present`,
    [MOVE_SENTINEL_TABLE_NAME]
  )
  return Boolean(result.rows[0]?.present)
}

async function dirtyTableExists(client: pg.Client): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    MOVE_DIRTY_TABLE
  ])
  return Boolean(result.rows[0]?.present)
}

export type TrackingState = {
  dirtyTable: boolean
  sentinel: boolean
  // Tables lacking any of the four triggers.
  untracked: string[]
}

export async function readTrackingState(
  client: pg.Client,
  tables: MoveTable[]
): Promise<TrackingState> {
  const dirtyTable = await dirtyTableExists(client)
  const triggers = await client.query(
    `SELECT c.relname AS name, count(*)::int AS triggers FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND t.tgname LIKE 'relay\\_move\\_track\\_%' AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
     GROUP BY c.relname`
  )
  const counts = new Map(triggers.rows.map((row) => [String(row.name), Number(row.triggers)]))
  return {
    dirtyTable,
    sentinel: await sentinelPresent(client),
    untracked: tables
      .filter((table) => (counts.get(table.name) ?? 0) < TRIGGERS.length)
      .map((table) => table.name)
  }
}

// Keys waiting to be synced, sentinel excluded; capped so a huge backlog stays a cheap read.
export async function readDirtyBacklog(client: pg.Client, cap = 1_000_000): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::bigint AS n FROM (
       SELECT 1 FROM ${MOVE_DIRTY_TABLE} WHERE table_name <> $1 LIMIT $2) d`,
    [MOVE_SENTINEL_TABLE_NAME, cap]
  )
  return Number(result.rows[0]?.n ?? 0)
}

// Puts keys back on the source's dirty set (as the tool role; the dirty table has no trigger).
export async function markSourceDirty(
  source: pg.Client,
  keys: Array<{ table: string; pk: string }>
): Promise<void> {
  if (keys.length === 0) return
  const items = keys.map((key) => `{"table":${JSON.stringify(key.table)},"pk":${key.pk}}`)
  await source.query(
    `INSERT INTO ${MOVE_DIRTY_TABLE} (table_name, pk, touched)
     SELECT k->>'table', k->'pk', 1 FROM jsonb_array_elements($1::jsonb) k
     ON CONFLICT (table_name, pk) DO UPDATE SET touched = ${MOVE_DIRTY_TABLE}.touched + 1`,
    [`[${items.join(',')}]`]
  )
}
