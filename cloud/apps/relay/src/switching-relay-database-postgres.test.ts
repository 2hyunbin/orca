import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { markRelayDatabaseMoveCapability } from './database.js'
import type { DatabaseTargetPointer } from './relay-database-target-pointer.js'
import { openPrimaryRelayDatabaseTarget } from './relay-database-targets.js'
import { SwitchingRelayDatabase } from './switching-relay-database.js'

const adminUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = adminUrl ? describe : describe.skip

// Two roles and databases on one server stand in for the shared and the dedicated instance.
const suffix = randomBytes(4).toString('hex')
const targets = {
  old: { role: `step4_old_${suffix}`, password: randomBytes(12).toString('hex') },
  new: { role: `step4_new_${suffix}`, password: randomBytes(12).toString('hex') }
}

function targetUrl(target: { role: string; password: string }): string {
  const url = new URL(adminUrl ?? 'postgres://localhost')
  url.username = target.role
  url.password = target.password
  url.pathname = `/${target.role}`
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

// The move tool's fence, as the relay role on the target it leaves.
async function fence(url: string): Promise<void> {
  await withClient(url, async (client) => {
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

describePostgres('switching relay database against two PostgreSQL targets', () => {
  beforeAll(async () => {
    await withClient(adminUrl ?? '', async (admin) => {
      for (const target of Object.values(targets)) {
        await admin.query(`CREATE ROLE ${target.role} LOGIN PASSWORD '${target.password}'`)
        await admin.query(`CREATE DATABASE ${target.role} OWNER ${target.role}`)
      }
    })
    for (const target of Object.values(targets)) {
      await withClient(targetUrl(target), async (client) => {
        await client.query(LOAD_TABLE)
      })
    }
    // Generation 0 on the old target; the new one has no authority table until cutover.
    await withClient(targetUrl(targets.old), async (client) => {
      await client.query(AUTHORITY_TABLE)
      await client.query(`INSERT INTO relay_database_authority (generation, written_at) VALUES (0, 0)`)
    })
  })

  afterAll(async () => {
    await withClient(adminUrl ?? '', async (admin) => {
      for (const target of Object.values(targets)) {
        await admin.query(`DROP DATABASE IF EXISTS ${target.role} WITH (FORCE)`)
        await admin.query(`DROP ROLE IF EXISTS ${target.role}`)
      }
    })
  })

  it('moves concurrent work to the new target through a fence with no failed operation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const settings = {
      poolMax: 6,
      applicationName: markRelayDatabaseMoveCapability('orca-relay/cell/step4-test')
    }
    const oldTarget = openPrimaryRelayDatabaseTarget(targetUrl(targets.old), settings)
    const newTarget = openPrimaryRelayDatabaseTarget(targetUrl(targets.new), settings)
    const dedicated = {
      instanceConnectionName: 'test-project:us-central1:relay-db',
      databaseUrlSecret: 'projects/test-project/secrets/relay-db-url/versions/latest'
    }
    const pointer = (quiesce?: DatabaseTargetPointer['quiesce']): DatabaseTargetPointer => ({
      version: 1,
      dedicated,
      ...(quiesce ? { quiesce } : {})
    })
    const database = new SwitchingRelayDatabase({
      primary: oldTarget,
      openDedicated: () => newTarget,
      firstPointer: async () => pointer()
    })
    await database.ready()
    expect(database.activeTargetName()).toBe('primary')

    const failures: unknown[] = []
    let written = 0
    let stop = false
    const worker = async (id: number): Promise<void> => {
      for (let n = 0; !stop; n++) {
        try {
          if (n % 2 === 0) {
            await database.query(`INSERT INTO step4_load (id, worker, at) VALUES (?, ?, ?)`, [
              `${id}-${n}`,
              id,
              Date.now()
            ])
          } else {
            await database.transaction(async (transaction) => {
              await transaction.query(`INSERT INTO step4_load (id, worker, at) VALUES (?, ?, ?)`, [
                `${id}-${n}`,
                id,
                Date.now()
              ])
              await transaction.query(`SELECT count(*) FROM step4_load WHERE worker = ?`, [id])
            })
          }
          written += 1
        } catch (error) {
          failures.push(error)
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
    const workers = Array.from({ length: 8 }, (_, id) => worker(id))
    await new Promise((resolve) => setTimeout(resolve, 300))

    // The tool's cutover, with the 2 s wait scaled down: hold, fence, drain, authority, clear.
    const startsAt = Date.now() + 200
    database.applyPointer(pointer({ id: 'cutover', startsAt, until: startsAt + 15_000 }))
    await new Promise((resolve) => setTimeout(resolve, startsAt + 300 - Date.now()))
    await fence(targetUrl(targets.old))
    // The admin reads the old copy: the relay role can no longer log in there.
    const oldAdminUrl = new URL(adminUrl ?? '')
    oldAdminUrl.pathname = `/${targets.old.role}`
    const oldRows = await withClient(oldAdminUrl.toString(), async (client) =>
      (await client.query(`SELECT id, worker, at FROM step4_load ORDER BY id`)).rows
    )
    await withClient(targetUrl(targets.new), async (client) => {
      for (const row of oldRows) {
        await client.query(`INSERT INTO step4_load (id, worker, at) VALUES ($1, $2, $3)`, [
          row.id,
          row.worker,
          row.at
        ])
      }
      await client.query(AUTHORITY_TABLE)
      await client.query(
        `INSERT INTO relay_database_authority (generation, written_at) VALUES (1, $1)`,
        [Date.now()]
      )
    })
    database.applyPointer(pointer())
    await new Promise((resolve) => setTimeout(resolve, 500))
    stop = true
    await Promise.all(workers)

    expect(failures).toEqual([])
    expect(database.activeTargetName()).toBe('dedicated')
    const newCount = await withClient(targetUrl(targets.new), async (client) =>
      Number((await client.query(`SELECT count(*) AS n FROM step4_load`)).rows[0]?.n)
    )
    // Every acknowledged write is on the new target: copied before the switch, or written after.
    expect(newCount).toBe(written)
    expect(oldRows.length).toBeLessThan(written)
    const names = await withClient(targetUrl(targets.new), async (client) =>
      (
        await client.query(
          `SELECT DISTINCT application_name FROM pg_stat_activity
           WHERE usename = current_user AND pid <> pg_backend_pid()`
        )
      ).rows.map((row) => String(row.application_name))
    )
    expect(names).toEqual(['orca-relay/cell/step4-test mv1'])
    await database.close()
  }, 30_000)
})
