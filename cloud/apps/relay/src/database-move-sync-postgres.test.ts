import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readMoveTables, type MoveTable } from './database-move-catalog.js'
import { prepareTargetCommand, syncCommand } from './database-move-commands.js'
import type { MoveDatabases } from './database-move-connections.js'
import { runCopy } from './database-move-copy.js'
import { runSyncLoop, type MoveSyncSessions } from './database-move-sync.js'
import {
  installTracking,
  readDirtyBacklog,
  uninstallTracking,
  type TrackingConflictAction
} from './database-move-tracking.js'
import { verifyMoveTables, verdictsEqual } from './database-move-verify.js'
import {
  createMoveTestSides,
  MemoryPointerStore,
  testPointerStore,
  withPgClient,
  type MoveTestSides
} from './test-fixtures/database-move-sides.js'

const adminUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = adminUrl ? describe : describe.skip

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  client.on('error', () => undefined)
  await client.connect()
  return client
}

describePostgres('database move: tracking, copy, sync and verify', () => {
  let sides: MoveTestSides
  let databases: MoveDatabases
  let sessions: MoveSyncSessions
  let app: pg.Client
  let tables: MoveTable[]

  const table = (name: string): MoveTable => {
    const found = tables.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no table ${name}`)
    return found
  }
  const track = async (conflictAction: TrackingConflictAction = 'update'): Promise<void> => {
    await installTracking(app, { toolUser: sides.primary.move.user, tables, conflictAction })
  }
  const drain = async (): Promise<void> => {
    await runSyncLoop(sessions, tables, { stopAtBacklog: 0, idleMs: 1, reportEveryMs: 60_000 })
  }
  const equal = async (only?: string[]): Promise<boolean> =>
    verdictsEqual(
      await verifyMoveTables(
        sessions.source,
        sessions.target,
        only ? tables.filter((candidate) => only.includes(candidate.name)) : tables,
        { chunkRows: 7 }
      )
    )
  const clearRelayRows = async (): Promise<void> => {
    for (const url of [sides.primary.adminUrl, sides.dedicated.adminUrl]) {
      await withPgClient(url, async (admin) => {
        await admin.query(`TRUNCATE ${tables.map((candidate) => candidate.name).join(', ')}`)
        await admin.query(`DELETE FROM relay_move_copy_progress`)
      })
    }
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    sides = await createMoveTestSides(adminUrl ?? '')
    databases = sides.databases()
    await prepareTargetCommand({
      databases,
      google: null,
      pointerStore: async () => testPointerStore()
    })
    app = await connect(sides.primary.app.url)
    tables = await readMoveTables(app)
    sessions = {
      source: await connect(sides.primary.move.url),
      target: await connect(sides.dedicated.move.url)
    }
  }, 60_000)

  afterEach(async () => {
    await uninstallTracking(app, tables)
    await clearRelayRows()
  })

  afterAll(async () => {
    for (const client of [app, sessions?.source, sessions?.target])
      await client?.end().catch(() => undefined)
    databases?.close()
    await sides?.drop()
    vi.restoreAllMocks()
  })

  it('refuses to prepare the target before the pointer exists', async () => {
    await expect(
      prepareTargetCommand({
        databases,
        google: null,
        pointerStore: async () => new MemoryPointerStore(null)
      })
    ).rejects.toThrow('pointer_absent')
  })

  it('covers every schema table except the authority, move and retired tables', () => {
    expect(tables.length).toBeGreaterThan(35)
    const names = tables.map((candidate) => candidate.name)
    expect(names).not.toContain('relay_database_authority')
    expect(names.filter((name) => name.startsWith('relay_move_'))).toEqual([])
    // Parents first, for the three foreign keys.
    expect(names.indexOf('relay_cell_fence_attempts')).toBeLessThan(
      names.indexOf('relay_cell_fence_plan_bindings')
    )
    expect(names.indexOf('relay_cell_drain_attempt_states')).toBeLessThan(
      names.indexOf('relay_cell_drain_recovery_attempts')
    )
  })

  it('ignores the tool role and marks every relay-role change, old and new key', async () => {
    await track()
    await sessions.source.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('tool-1', 1, 't', '{}')`
    )
    expect(await readDirtyBacklog(sessions.source)).toBe(0)
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('app-1', 1, 't', '{}')`
    )
    await app.query(`UPDATE relay_audit_events SET id = 'app-2' WHERE id = 'app-1'`)
    const keys = await sessions.source.query(
      `SELECT pk::text AS pk FROM relay_move_dirty WHERE table_name = 'relay_audit_events' ORDER BY 1`
    )
    expect(keys.rows.map((row) => row.pk)).toEqual(['{"id": "app-1"}', '{"id": "app-2"}'])
  })

  it('stops the sync when the dirty set was emptied, until a restarted copy re-arms it', async () => {
    await track()
    await app.query(`TRUNCATE relay_audit_events`)
    await expect(drain()).rejects.toThrow('dirty_set_was_emptied_recopy_needed')
    await runCopy(sessions, tables, { restart: true, maxBytesPerSecond: 1e9 })
    await drain()
  })

  it('lets another role that writes relay rows keep writing once tracking is on', async () => {
    const writer = `${sides.primary.app.user}_writer`
    await withPgClient(sides.primary.adminUrl, async (admin) => {
      await admin.query(`CREATE ROLE ${writer} LOGIN PASSWORD 'writer'`)
    })
    try {
      await app.query(`GRANT INSERT ON relay_audit_events TO ${writer}`)
      await track()
      const url = new URL(sides.primary.adminUrl)
      url.username = writer
      url.password = 'writer'
      await withPgClient(url.toString(), (client) =>
        client.query(
          `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('x', 1, 't', '{}')`
        )
      )
      expect(await readDirtyBacklog(sessions.source)).toBe(1)
    } finally {
      await withPgClient(sides.primary.adminUrl, async (admin) => {
        await admin.query(`DROP OWNED BY ${writer}`)
        await admin.query(`DROP ROLE ${writer}`)
      })
    }
  })

  it('stops copy and sync when a table loses its triggers', async () => {
    await track()
    await app.query(`DROP TRIGGER relay_move_track_upd ON relay_cells`)
    await expect(runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })).rejects.toThrow(
      'tables_without_tracking'
    )
    await expect(
      runSyncLoop(sessions, tables, { stopAtBacklog: 0, schemaCheckEveryMs: 0 })
    ).rejects.toThrow('tables_without_tracking')
  })

  it("stops on a column added mid-run and resets that table's copy position", async () => {
    await track()
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })
    try {
      await app.query(`ALTER TABLE relay_audit_events ADD COLUMN mid_run TEXT`)
      const refusal = await runSyncLoop(sessions, tables, {
        stopAtBacklog: 0,
        schemaCheckEveryMs: 0
      }).catch((error: unknown) => error)
      expect(refusal).toMatchObject({
        reason: 'schema_changed_during_run',
        details: { tables: ['relay_audit_events'], copyProgressReset: true }
      })
      const progress = await sessions.target.query(
        `SELECT table_name FROM relay_move_copy_progress WHERE table_name = 'relay_audit_events'`
      )
      expect(progress.rows).toEqual([])
      await expect(runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })).rejects.toThrow(
        'schema_changed_during_run'
      )
    } finally {
      await app.query(`ALTER TABLE relay_audit_events DROP COLUMN IF EXISTS mid_run`)
    }
  })

  it('paces the copy on what the source reads from disk, dead pages included', async (context) => {
    // Evicting the table from shared buffers needs pg_buffercache_evict (Postgres 17+).
    const evictable = await withPgClient(sides.primary.adminUrl, async (admin) => {
      await admin.query('CREATE EXTENSION IF NOT EXISTS pg_buffercache')
      const found = await admin.query(`SELECT to_regproc('pg_buffercache_evict') IS NOT NULL AS ok`)
      return Boolean(found.rows[0]?.ok)
    })
    if (!evictable) context.skip()
    await track()
    // 20,000 rows written and 19,900 deleted: the live JSON is tiny, the pages are not.
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 'b' || lpad(n::text, 6, '0'), n, 't', repeat('x', 300) FROM generate_series(1, 20000) n`
    )
    await app.query(`DELETE FROM relay_audit_events WHERE at > 100`)
    const evicted = await withPgClient(sides.primary.adminUrl, async (admin) => {
      const result = await admin.query(
        `SELECT count(*) FILTER (WHERE pg_buffercache_evict(bufferid))::int AS n FROM pg_buffercache
         WHERE relfilenode IN (SELECT pg_relation_filenode(oid) FROM pg_class
                               WHERE relname LIKE 'relay_audit_events%')`
      )
      return Number(result.rows[0]?.n)
    })
    expect(evicted).toBeGreaterThan(100)
    const budget = 2_000_000
    const startedAt = Date.now()
    const result = await runCopy(sessions, tables, { maxBytesPerSecond: budget, batchRows: 50 })
    const elapsedMs = Date.now() - startedAt
    console.error(JSON.stringify({ pacing: result, elapsedMs }))
    expect(result.readBytes).toBeGreaterThan(result.bytes * 10)
    expect(elapsedMs).toBeGreaterThanOrEqual((result.readBytes * 1000) / budget - 50)
  })

  it('caps the copy at the row rate', async () => {
    await track()
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 'r' || n, n, 't', '{}' FROM generate_series(1, 300) n`
    )
    const startedAt = Date.now()
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9, maxRowsPerSecond: 500 })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550)
  })

  it('refuses a copy made before tracking was installed again, until it is redone', async () => {
    await track()
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 'u' || n, n, 't', '{}' FROM generate_series(1, 200) n`
    )
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })
    await drain()
    // Tracking off, relay writes, tracking on: nothing recorded those writes.
    await uninstallTracking(app, tables)
    await app.query(`UPDATE relay_audit_events SET at = -at WHERE at <= 50`)
    await app.query(`DELETE FROM relay_audit_events WHERE at > 150`)
    await track()
    await expect(runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })).rejects.toThrow(
      'copy_predates_tracking'
    )
    await expect(
      syncCommand(
        { databases, google: null, pointerStore: async () => testPointerStore() },
        'primary',
        { stopAtBacklog: 0 }
      )
    ).rejects.toThrow('copy_predates_tracking')
    expect(await equal(['relay_audit_events'])).toBe(false)
    const redone = await runCopy(sessions, tables, { restart: true, maxBytesPerSecond: 1e9 })
    expect(redone.rows).toBe(150)
    await drain()
    expect(await equal()).toBe(true)
  })

  it('starts a new arming when a table was left without triggers, voiding the copy', async () => {
    await track()
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })
    // An untrack that stopped after one table: that table's writes go unrecorded.
    for (const suffix of ['ins', 'upd', 'del', 'trunc']) {
      await app.query(`DROP TRIGGER relay_move_track_${suffix} ON relay_audit_events`)
    }
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('gap', 1, 't', '{}')`
    )
    await track()
    await expect(runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })).rejects.toThrow(
      'copy_predates_tracking'
    )
    await runCopy(sessions, tables, { restart: true, maxBytesPerSecond: 1e9 })
    expect(await equal(['relay_audit_events'])).toBe(true)
  })

  it('refuses to sync into a target with no finished copy under the current arming', async () => {
    await track()
    await expect(
      syncCommand(
        { databases, google: null, pointerStore: async () => testPointerStore() },
        'primary',
        { stopAtBacklog: 0 }
      )
    ).rejects.toThrow('target_not_current')
  })

  it('keeps BIGINTs past 2^53 exact through copy and sync', async () => {
    await track()
    const big = '9223372036854775807'
    const odd = '9007199254740993'
    await app.query(
      `INSERT INTO relay_rate_windows (scope_key, window_kind, window_started_at, count) VALUES ('s', 'k', $1, $2)`,
      [odd, big]
    )
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })
    await app.query(
      `UPDATE relay_rate_windows SET count = count - 1 WHERE window_started_at = $1`,
      [odd]
    )
    await drain()
    const row = await sessions.target.query(
      `SELECT window_started_at::text AS started, count::text AS count FROM relay_rate_windows`
    )
    expect(row.rows).toEqual([{ started: odd, count: '9223372036854775806' }])
    expect(await equal(['relay_rate_windows'])).toBe(true)
  })

  it('lands children after parents and deletes them first, one key per batch', async () => {
    await track()
    for (let n = 0; n < 6; n++) {
      await app.query('BEGIN')
      await app.query(
        `INSERT INTO relay_cell_fence_attempts (attempt_id, environment, cell_id, cell_incarnation, mig_name,
           instance_group, generation_identity, fence_commit, plan_sha256, created_at, expires_at)
         VALUES ($1, 'e', 'c', 'i', 'm', 'g', 'gi', 'fc', 'sha', 1, 2)`,
        [`a${n}`]
      )
      await app.query(
        `INSERT INTO relay_cell_fence_apply_invocations (invocation_id, attempt_id, request_reason, started_at)
         VALUES ($1, $2, $3, 1)`,
        [`i${n}`, `a${n}`, `reason-${n}`]
      )
      await app.query('COMMIT')
    }
    await runSyncLoop(sessions, tables, { stopAtBacklog: 0, batchKeys: 1, idleMs: 1 })
    expect(await equal(['relay_cell_fence_attempts', 'relay_cell_fence_apply_invocations'])).toBe(
      true
    )
    // A unique value moved to a new key, and parents deleted with their children.
    await app.query(`DELETE FROM relay_cell_fence_apply_invocations WHERE invocation_id = 'i0'`)
    await app.query(
      `INSERT INTO relay_cell_fence_apply_invocations (invocation_id, attempt_id, request_reason, started_at)
       VALUES ('i0-new', 'a1', 'reason-0', 2)`
    )
    await app.query(
      `DELETE FROM relay_cell_fence_apply_invocations WHERE attempt_id IN ('a2', 'a3')`
    )
    await app.query(`DELETE FROM relay_cell_fence_attempts WHERE attempt_id IN ('a2', 'a3')`)
    await runSyncLoop(sessions, tables, { stopAtBacklog: 0, batchKeys: 1, idleMs: 1 })
    expect(await equal(['relay_cell_fence_attempts', 'relay_cell_fence_apply_invocations'])).toBe(
      true
    )
  })

  it('settles unique values two keys swap within one batch', async () => {
    await track()
    const cell = (id: string, url: string): Promise<unknown> =>
      app.query(
        `INSERT INTO relay_cells (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
           observed_requests, last_heartbeat_at, updated_at) VALUES ($1, $2, 1, 1, 0, 0, 0, 0)`,
        [id, url]
      )
    await cell('a', 'https://one')
    await cell('b', 'https://two')
    await drain()
    await app.query('BEGIN')
    await app.query(`UPDATE relay_cells SET cell_url = 'https://swap' WHERE cell_id = 'a'`)
    await app.query(`UPDATE relay_cells SET cell_url = 'https://one' WHERE cell_id = 'b'`)
    await app.query(`UPDATE relay_cells SET cell_url = 'https://two' WHERE cell_id = 'a'`)
    await app.query('COMMIT')
    await drain()
    expect(await equal(['relay_cells'])).toBe(true)
  })

  it('removes target rows the source deleted while untracked when the copy runs again', async () => {
    await track()
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 's' || lpad(n::text, 3, '0'), n, 't', '{}' FROM generate_series(1, 120) n`
    )
    await runCopy(sessions, tables, { batchRows: 25, maxBytesPerSecond: 1e9 })
    await drain()
    // Deleted as the tool role, so no key is tracked: what a lost dirty set leaves behind.
    await sessions.source.query(
      `DELETE FROM relay_audit_events WHERE id IN ('s001', 's050', 's051', 's120')`
    )
    expect(await equal(['relay_audit_events'])).toBe(false)
    await runCopy(sessions, tables, { batchRows: 25, restart: true, maxBytesPerSecond: 1e9 })
    expect(await equal(['relay_audit_events'])).toBe(true)
  })

  it('resumes a copy from the last committed page', async () => {
    await track()
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 'e' || lpad(n::text, 5, '0'), n, 't', '{}' FROM generate_series(1, 1200) n`
    )
    // A stalled copy: the target session dies after a few pages.
    const target = await connect(sides.dedicated.move.url)
    const pid = (await target.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    // Killed once the first pages of the table have committed.
    const killer = setInterval(() => {
      void withPgClient(sides.dedicated.adminUrl, async (admin) => {
        const progress = await admin.query(
          `SELECT rows_copied FROM relay_move_copy_progress WHERE table_name = 'relay_audit_events'`
        )
        if (Number(progress.rows[0]?.rows_copied ?? 0) > 0) {
          await admin.query('SELECT pg_terminate_backend($1)', [pid])
        }
      })
    }, 20)
    await expect(
      runCopy({ source: sessions.source, target }, tables, {
        batchRows: 50,
        maxBytesPerSecond: 20_000
      })
    ).rejects.toThrow()
    clearInterval(killer)
    await target.end().catch(() => undefined)
    const partial = await sessions.target.query(
      `SELECT rows_copied::int AS rows, done FROM relay_move_copy_progress WHERE table_name = 'relay_audit_events'`
    )
    const first = Number(partial.rows[0]?.rows ?? 0)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1200)
    const resumed = await runCopy(sessions, tables, { batchRows: 50, maxBytesPerSecond: 1e9 })
    expect(resumed.rows).toBe(1200 - first)
    expect(await equal(['relay_audit_events'])).toBe(true)
  })

  it('names the keys of a range that differs', async () => {
    await track()
    await app.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json)
       SELECT 'v' || n, n, 't', '{}' FROM generate_series(1, 30) n`
    )
    await runCopy(sessions, tables, { maxBytesPerSecond: 1e9 })
    await withPgClient(sides.dedicated.adminUrl, async (admin) => {
      await admin.query(`UPDATE relay_audit_events SET at = -1 WHERE id = 'v17'`)
      await admin.query(
        `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('zz', 1, 't', '{}')`
      )
    })
    const verdicts = await verifyMoveTables(
      sessions.source,
      sessions.target,
      [table('relay_audit_events')],
      {
        chunkRows: 7
      }
    )
    const keys = verdicts[0]?.mismatches.flatMap((mismatch) => mismatch.keys)
    expect(keys).toEqual(['{"id": "v17"}', '{"id": "zz"}'])
  })

  // Writers hold their transaction open after the trigger marked a key, while the sync claims
  // and reads as fast as it can. With DO UPDATE the claim must pass over a held key, so nothing
  // committed after the read is lost; with DO NOTHING it is not, and the copies drift.
  async function raceRound(): Promise<{ equal: boolean; operations: number }> {
    const writers = await Promise.all(
      Array.from({ length: 6 }, () => connect(sides.primary.app.url))
    )
    let stop = false
    let operations = 0
    const write = async (client: pg.Client): Promise<void> => {
      while (!stop) {
        const key = `k${Math.floor(Math.random() * 12)}`
        const roll = Math.random()
        await client.query('BEGIN')
        if (roll < 0.15) {
          await client.query(`DELETE FROM relay_audit_events WHERE id = $1`, [key])
        } else {
          await client.query(
            `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ($1, $2, 't', '{}')
             ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at`,
            [key, Math.floor(Math.random() * 1e9)]
          )
        }
        await client.query(`SELECT pg_sleep($1)`, [Math.random() * 0.004])
        await client.query('COMMIT')
        operations += 1
      }
    }
    const syncing = runSyncLoop(sessions, tables, {
      shouldStop: () => stop,
      idleMs: 0,
      batchKeys: 4
    })
    const running = writers.map(write)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    stop = true
    await Promise.all(running)
    await syncing
    await drain()
    await Promise.all(writers.map((client) => client.end()))
    return { equal: await equal(['relay_audit_events']), operations }
  }

  it('loses no change under concurrent writers and sync claims (DO UPDATE)', async () => {
    await track('update')
    let operations = 0
    for (let round = 0; round < 6; round++) {
      const result = await raceRound()
      operations += result.operations
      expect(result.equal).toBe(true)
    }
    console.error(JSON.stringify({ race: 'do-update', rounds: 6, operations }))
  }, 60_000)

  it('the same race loses changes when the trigger uses DO NOTHING', async () => {
    await track('nothing')
    let diverged = 0
    let rounds = 0
    while (rounds < 12 && diverged === 0) {
      rounds += 1
      if (!(await raceRound()).equal) diverged += 1
    }
    console.error(JSON.stringify({ race: 'do-nothing', rounds, diverged }))
    expect(diverged).toBeGreaterThan(0)
  }, 60_000)
})
