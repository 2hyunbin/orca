import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markRelayDatabaseMoveCapability } from './database.js'
import type { DatabaseTargetPointer } from './relay-database-target-pointer.js'
import { openPrimaryRelayDatabaseTarget } from './relay-database-targets.js'
import { SwitchingRelayDatabase } from './switching-relay-database.js'

const adminUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = adminUrl ? describe : describe.skip

type Target = { role: string; password: string }
const created: string[] = []

function databaseUrl(database: string, credentials?: Target): string {
  const url = new URL(adminUrl ?? 'postgres://localhost')
  if (credentials) {
    url.username = credentials.role
    url.password = credentials.password
  }
  url.pathname = `/${database}`
  return url.toString()
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}

const LOAD_TABLE = `CREATE TABLE step4_load (id TEXT PRIMARY KEY, worker INT NOT NULL, at BIGINT NOT NULL)`
const AUTHORITY_TABLE = `CREATE TABLE relay_database_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation BIGINT NOT NULL,
  written_at BIGINT NOT NULL
)`

// Two roles and databases on one server stand in for the shared and the dedicated instance.
async function freshTargets(): Promise<{ old: Target; new: Target }> {
  const suffix = randomBytes(4).toString('hex')
  const targets = {
    old: { role: `step4_old_${suffix}`, password: randomBytes(12).toString('hex') },
    new: { role: `step4_new_${suffix}`, password: randomBytes(12).toString('hex') }
  }
  await withClient(adminUrl ?? '', async (admin) => {
    for (const target of Object.values(targets)) {
      await admin.query(`CREATE ROLE ${target.role} LOGIN PASSWORD '${target.password}'`)
      await admin.query(`CREATE DATABASE ${target.role} OWNER ${target.role}`)
      created.push(target.role)
    }
  })
  for (const target of Object.values(targets)) {
    await withClient(databaseUrl(target.role, target), async (client) => {
      await client.query(LOAD_TABLE)
    })
  }
  // Generation 0 on the old target; the new one has no authority table until cutover.
  await withClient(databaseUrl(targets.old.role, targets.old), async (client) => {
    await client.query(AUTHORITY_TABLE)
    await client.query(`INSERT INTO relay_database_authority (generation, written_at) VALUES (0, 0)`)
  })
  return targets
}

// The move tool's fence, as the relay role on the target it leaves.
async function fence(target: Target): Promise<void> {
  await withClient(databaseUrl(target.role, target), async (client) => {
    await client.query(`ALTER ROLE CURRENT_USER PASSWORD '${randomBytes(16).toString('hex')}'`)
    let clean = 0
    while (clean < 2) {
      const result = await client.query(
        `SELECT count(pg_terminate_backend(pid)) AS terminated FROM pg_stat_activity
         WHERE usename = current_user AND pid <> pg_backend_pid()`
      )
      clean = Number(result.rows[0]?.terminated) === 0 ? clean + 1 : 0
    }
  })
}

// The tool's last steps after the fence: copy the rows, then raise the new target's generation.
async function drainAndRaise(targets: { old: Target; new: Target }): Promise<number> {
  // The admin reads the old copy: the relay role can no longer log in there.
  const oldRows = await withClient(
    databaseUrl(targets.old.role),
    async (client) => (await client.query(`SELECT id, worker, at FROM step4_load ORDER BY id`)).rows
  )
  await withClient(databaseUrl(targets.new.role, targets.new), async (client) => {
    for (const row of oldRows) {
      await client.query(`INSERT INTO step4_load (id, worker, at) VALUES ($1, $2, $3)`, [
        row.id,
        row.worker,
        row.at
      ])
    }
    await client.query(AUTHORITY_TABLE)
    await client.query(`INSERT INTO relay_database_authority (generation, written_at) VALUES (1, $1)`, [
      Date.now()
    ])
  })
  return oldRows.length
}

async function sessionNames(target: Target): Promise<string[]> {
  return await withClient(databaseUrl(target.role), async (client) =>
    (
      await client.query(
        `SELECT DISTINCT application_name FROM pg_stat_activity
         WHERE usename = $1 ORDER BY application_name`,
        [target.role]
      )
    ).rows.map((row) => String(row.application_name))
  )
}

const dedicated = {
  instanceConnectionName: 'test-project:us-central1:relay-db',
  databaseUrlSecret: 'projects/test-project/secrets/relay-db-url/versions/latest'
}

function pointer(
  quiesce?: DatabaseTargetPointer['quiesce'],
  generation?: number
): DatabaseTargetPointer {
  return {
    version: 1,
    dedicated,
    ...(generation === undefined ? {} : { generation }),
    ...(quiesce ? { quiesce } : {})
  }
}

function switchingDatabase(
  targets: { old: Target; new: Target },
  poolMax: number,
  firstPointer: () => Promise<DatabaseTargetPointer | null> = async () => pointer()
) {
  const applicationName = markRelayDatabaseMoveCapability('orca-relay/cell/step4-test', 'c0ffee01')
  const settings = { poolMax, applicationName }
  const database = new SwitchingRelayDatabase({
    primary: openPrimaryRelayDatabaseTarget(databaseUrl(targets.old.role, targets.old), settings),
    openDedicated: () =>
      openPrimaryRelayDatabaseTarget(databaseUrl(targets.new.role, targets.new), settings),
    firstPointer,
    // Short, so the tests below run past the boot window's refusal re-selection.
    bootSelectionCapMs: 100
  })
  return { database, applicationName }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describePostgres('switching relay database against two PostgreSQL targets', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await withClient(adminUrl ?? '', async (admin) => {
      for (const role of created) {
        await admin.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`)
        await admin.query(`DROP ROLE IF EXISTS ${role}`)
      }
    })
  })

  it('moves concurrent work to the new target through a fence with no failed operation', async () => {
    const targets = await freshTargets()
    const { database, applicationName } = switchingDatabase(targets, 6)
    await database.ready()
    expect(database.activeTargetName()).toBe('primary')

    const failures: unknown[] = []
    let written = 0
    let stop = false
    const worker = async (id: number): Promise<void> => {
      for (let n = 0; !stop; n++) {
        const values = [`${id}-${n}`, id, Date.now()]
        try {
          if (n % 2 === 0) {
            await database.query(`INSERT INTO step4_load (id, worker, at) VALUES (?, ?, ?)`, values)
          } else {
            await database.transaction(async (transaction) => {
              await transaction.query(`INSERT INTO step4_load (id, worker, at) VALUES (?, ?, ?)`, values)
              await transaction.query(`SELECT count(*) FROM step4_load WHERE worker = ?`, [id])
            })
          }
          written += 1
        } catch (error) {
          failures.push(error)
        }
        await sleep(2)
      }
    }
    const workers = Array.from({ length: 8 }, (_, id) => worker(id))
    await sleep(300)

    // The tool's cutover, with the 2 s wait scaled down: hold, fence, drain, authority, clear.
    const startsAt = Date.now() + 200
    database.applyPointer(pointer({ id: 'cutover', startsAt, until: startsAt + 15_000 }))
    await sleep(startsAt + 300 - Date.now())
    // What the tool checks before it fences: this process already holds a session there.
    expect(await sessionNames(targets.new)).toEqual([applicationName])
    await fence(targets.old)
    const oldRows = await drainAndRaise(targets)
    database.applyPointer(pointer(undefined, 1))
    await sleep(500)
    stop = true
    await Promise.all(workers)

    expect(failures).toEqual([])
    expect(database.activeTargetName()).toBe('dedicated')
    // Every acknowledged write is on the new target: copied before the switch, or written after.
    const newCount = await withClient(databaseUrl(targets.new.role, targets.new), async (client) =>
      Number((await client.query(`SELECT count(*) AS n FROM step4_load`)).rows[0]?.n)
    )
    expect(newCount).toBe(written)
    expect(oldRows).toBeLessThan(written)
    expect(await sessionNames(targets.new)).toEqual([applicationName])
    await database.close()
  }, 30_000)

  it('re-runs work that queued for a session in the window on the new target', async () => {
    const targets = await freshTargets()
    const { database } = switchingDatabase(targets, 2)
    await database.ready()
    await sleep(150)
    const startsAt = Date.now() + 100
    database.applyPointer(pointer({ id: 'cutover', startsAt, until: startsAt + 15_000 }))
    // Both pooled sessions are busy past the fence, so the queued insert needs a fresh login.
    const sleepers = [0, 1].map(
      async () => await database.query('SELECT pg_sleep(1)').then(() => 'ran', () => 'ended')
    )
    await sleep(20)
    const queued = database.query(`INSERT INTO step4_load (id, worker, at) VALUES (?, ?, ?)`, [
      'queued',
      0,
      Date.now()
    ])
    await sleep(startsAt + 200 - Date.now())
    await fence(targets.old)
    await drainAndRaise(targets)
    await queued
    // The sleepers ran a statement, so the fence ending them is surfaced, never re-run.
    expect(await Promise.all(sleepers)).toEqual(['ended', 'ended'])
    expect(database.activeTargetName()).toBe('dedicated')
    const onNew = await withClient(databaseUrl(targets.new.role, targets.new), async (client) =>
      (await client.query(`SELECT id FROM step4_load WHERE id = 'queued'`)).rows
    )
    expect(onNew).toEqual([{ id: 'queued' }])
    await database.close()
  }, 30_000)

  it('needs a pointer read once primary has the authority table, and serves as today without it', async () => {
    const targets = await freshTargets()
    const old = databaseUrl(targets.old.role, targets.old)
    await withClient(old, async (client) => await client.query(`DROP TABLE relay_database_authority`))
    // No table, no pointer: today's behaviour.
    const plain = switchingDatabase(targets, 2, async () => null).database
    expect(await plain.query('SELECT 1 AS one')).toEqual([{ one: 1 }])
    await plain.close()

    // The move has begun; the pointer cannot be read yet.
    await withClient(old, async (client) => {
      await client.query(AUTHORITY_TABLE)
      await client.query(`INSERT INTO relay_database_authority (generation, written_at) VALUES (0, 0)`)
    })
    const bucket: { pointer: DatabaseTargetPointer | null } = { pointer: null }
    const { database } = switchingDatabase(targets, 2, async () => {
      if (bucket.pointer) database.applyPointer(bucket.pointer)
      return bucket.pointer
    })
    const insert = `INSERT INTO step4_load (id, worker, at) VALUES ('stray', 0, 0)`
    await expect(database.query(insert)).rejects.toMatchObject({ code: '57P03' })
    await expect(database.query(insert)).rejects.toMatchObject({ code: '57P03' })
    const stray = await withClient(old, async (client) =>
      (await client.query(`SELECT id FROM step4_load WHERE id = 'stray'`)).rows
    )
    expect(stray).toEqual([])
    bucket.pointer = pointer()
    await sleep(1_500)
    expect(await database.query(`SELECT 1 AS one`)).toEqual([{ one: 1 }])
    expect(database.activeTargetName()).toBe('primary')
    await database.close()
  }, 30_000)
})
