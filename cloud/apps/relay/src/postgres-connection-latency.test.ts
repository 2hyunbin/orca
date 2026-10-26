import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'
import {
  SLOW_CONNECTION_MEDIAN_MS,
  SLOW_CONNECTION_RETIRE_INTERVAL_MS,
  SLOW_CONNECTION_WINDOW
} from './postgres-connection-latency.js'

let clock = 0

// A one-connection pool: a client is reused until released with a truthy value, as pg-pool does.
function onePool(statementMs: () => number) {
  const releases: unknown[] = []
  let dialed = 0
  let current: ReturnType<typeof dial> | undefined
  function dial() {
    dialed++
    return Object.assign(new EventEmitter(), {
      query: async () => {
        clock += statementMs()
        return { rows: [], rowCount: 0 }
      },
      release: (destroy?: unknown) => {
        releases.push(destroy)
        if (destroy) {
          current = undefined
        }
      }
    })
  }
  const pool = {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => (current ??= dial())
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  const database = new PostgresDatabase(pool as never)
  return { database, releases, dialed: () => dialed }
}

async function runStatements(database: PostgresDatabase, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await database.query('SELECT 1')
  }
}

describe('slow connection retirement', () => {
  let warnings: string[]

  beforeEach(() => {
    clock = 0
    warnings = []
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(console, 'warn').mockImplementation((line: string) => void warnings.push(line))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('destroys a connection whose recent median turned slow, and logs it once', async () => {
    const pool = onePool(() => 55)
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW)

    expect(pool.releases.slice(0, -1).every((release) => release === undefined)).toBe(true)
    expect(pool.releases.at(-1)).toBe(true)
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'orca_relay_postgres_slow_connection_retired',
        connectionId: 1,
        medianMs: 55,
        statements: SLOW_CONNECTION_WINDOW
      }
    ])
  })

  it('keeps a fast connection', async () => {
    const pool = onePool(() => 3)
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW * 3)

    expect(pool.releases.every((release) => release === undefined)).toBe(true)
    expect(pool.dialed()).toBe(1)
  })

  it('judges the median, so one long statement does not retire a healthy connection', async () => {
    let calls = 0
    const pool = onePool(() => (++calls === SLOW_CONNECTION_WINDOW ? 500 : 3))
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW * 2)

    expect(pool.releases.every((release) => release === undefined)).toBe(true)
  })

  it('judges a transaction connection on release, never mid-transaction', async () => {
    const pool = onePool(() => SLOW_CONNECTION_MEDIAN_MS * 2)
    await pool.database.transaction(async (tx) => {
      for (let index = 0; index < SLOW_CONNECTION_WINDOW; index++) {
        await tx.query('SELECT 1')
      }
    })

    expect(pool.releases).toEqual([true])
  })

  it('opens no connection itself: the pool redials only on the next ask', async () => {
    const pool = onePool(() => 55)
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW)
    expect(pool.dialed()).toBe(1)

    await runStatements(pool.database, 1)
    expect(pool.dialed()).toBe(2)
  })

  it('retires at most one connection per interval when every connection is slow', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const pool = onePool(() => 55)
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW)
    await runStatements(pool.database, SLOW_CONNECTION_WINDOW)
    expect(pool.releases.filter(Boolean)).toHaveLength(1)

    now += SLOW_CONNECTION_RETIRE_INTERVAL_MS
    await runStatements(pool.database, 1)
    expect(pool.releases.filter(Boolean)).toHaveLength(2)
    expect(pool.dialed()).toBe(2)
  })
})
