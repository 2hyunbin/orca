import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { RelayDatabase, SqlRow } from './database.js'
import type { DatabaseQuiesce, DatabaseTargetPointer } from './relay-database-target-pointer.js'
import type { OpenedRelayDatabaseTarget, RelayDatabaseTarget } from './relay-database-targets.js'
import { SwitchingRelayDatabase } from './switching-relay-database.js'

// `null` refuses the probe; `hang` never answers, like a timeout or a dead socket.
type Answer = number | null | 'hang'

type FakeTarget = RelayDatabaseTarget & {
  opened: OpenedRelayDatabaseTarget
  answer: Answer
  probes: number
  // A query whose SQL is `fail:<code>` rejects with that code.
  queries: string[]
}

function fakeTarget(name: string, answer: Answer): FakeTarget {
  const queries: string[] = []
  const run = async (sql: string): Promise<SqlRow[]> => {
    queries.push(sql)
    if (sql.startsWith('fail:')) {
      throw Object.assign(new Error('refused'), { code: sql.slice('fail:'.length) })
    }
    if (sql.startsWith('wait:')) await new Promise((resolve) => setTimeout(resolve, Number(sql.slice(5))))
    return [{ target: name }]
  }
  const database: RelayDatabase = {
    dialect: 'postgres',
    query: run,
    queryLocked: run,
    transaction: async (operation) => await operation(database),
    close: async () => undefined
  }
  const target: FakeTarget = {
    opened: { database, applySchema: async () => void queries.push('schema') },
    answer,
    probes: 0,
    queries,
    probe: async () => {
      target.probes += 1
      const current = target.answer
      if (current === 'hang') return await new Promise(() => undefined)
      return current === null ? null : { generation: current, opened: target.opened }
    },
    close: async () => undefined
  }
  return target
}

const DEDICATED = {
  instanceConnectionName: 'onorca-cloud:us-central1:relay-db',
  databaseUrlSecret: 'projects/onorca-cloud/secrets/relay-db-url/versions/latest'
}

function pointer(quiesce?: DatabaseQuiesce): DatabaseTargetPointer {
  return { version: 1, dedicated: DEDICATED, ...(quiesce ? { quiesce } : {}) }
}

function quiesceFromNow(id: string, startsInMs: number, lastsMs: number): DatabaseQuiesce {
  const startsAt = Date.now() + startsInMs
  return { id, startsAt, until: startsAt + lastsMs }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function servedBy(database: RelayDatabase, sql = 'SELECT 1'): Promise<unknown> {
  return (await database.query(sql))[0]?.target
}

function setup(input: {
  primary: Answer
  dedicated: Answer
  firstPointer?: DatabaseTargetPointer | null | 'hang'
}) {
  const primary = fakeTarget('primary', input.primary)
  const dedicated = fakeTarget('dedicated', input.dedicated)
  const openDedicated = vi.fn(() => dedicated)
  const first = input.firstPointer === undefined ? pointer() : input.firstPointer
  const database = new SwitchingRelayDatabase({
    primary,
    openDedicated,
    firstPointer: async () =>
      first === 'hang' ? await new Promise<null>(() => undefined) : first,
    probeTimeoutMs: 40,
    probeIntervalMs: 10,
    bootSelectionCapMs: 150
  })
  return { primary, dedicated, openDedicated, database }
}

describe('switching relay database', () => {
  let log: MockInstance<typeof console.log>
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const events = (name: string): Record<string, unknown>[] =>
    log.mock.calls
      .map((call): unknown => JSON.parse(String(call[0])))
      .filter(
        (line): line is Record<string, unknown> =>
          typeof line === 'object' && line !== null && 'event' in line && line.event === name
      )

  it('serves DATABASE_URL alone when there is no pointer, and never opens the dedicated target', async () => {
    const { database, openDedicated, primary } = setup({ primary: 0, dedicated: 5, firstPointer: null })
    expect(await servedBy(database)).toBe('primary')
    expect(openDedicated).not.toHaveBeenCalled()
    expect(primary.probes).toBe(0)
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', reason: 'no-pointer', phase: 'boot' })
    ])
  })

  it('gives a boot tie to primary', async () => {
    const { database } = setup({ primary: 3, dedicated: 3 })
    expect(await servedBy(database)).toBe('primary')
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', generation: 3, reason: 'tie' })
    ])
  })

  it('boots on the target with the higher generation', async () => {
    const { database } = setup({ primary: 1, dedicated: 2 })
    expect(await servedBy(database)).toBe('dedicated')
    const second = setup({ primary: 4, dedicated: 2 })
    expect(await servedBy(second.database)).toBe('primary')
  })

  it('boots on primary when neither target accepts', async () => {
    const { database } = setup({ primary: null, dedicated: null })
    expect(await servedBy(database)).toBe('primary')
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', reason: 'none-accepting' })
    ])
  })

  it('never hands boot to a never-cut-over dedicated target because primary timed out', async () => {
    const { database } = setup({ primary: 'hang', dedicated: 0 })
    expect(await servedBy(database)).toBe('primary')
    const cutOver = setup({ primary: 'hang', dedicated: 1 })
    expect(await servedBy(cutOver.database)).toBe('dedicated')
  })

  it('holds operations until the boot selection resolves, capped', async () => {
    const { database, primary } = setup({ primary: 0, dedicated: 0, firstPointer: 'hang' })
    const startedAt = Date.now()
    expect(await servedBy(database)).toBe('primary')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(primary.queries).toEqual(['SELECT 1'])
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', reason: 'timeout' })
    ])
  })

  it('holds new work from startsAt and releases it onto the target that reports a higher generation', async () => {
    const { database, dedicated } = setup({ primary: 0, dedicated: 0 })
    expect(await servedBy(database)).toBe('primary')
    database.applyPointer(pointer(quiesceFromNow('cut-1', 30, 2_000)))
    await sleep(50)
    const held = servedBy(database)
    await sleep(60)
    expect(dedicated.queries).toEqual([])
    dedicated.answer = 1
    expect(await held).toBe('dedicated')
    expect(await servedBy(database)).toBe('dedicated')
    expect(events('orca_relay_database_quiesce_started')).toEqual([
      expect.objectContaining({ id: 'cut-1' })
    ])
    expect(events('orca_relay_database_switched')).toEqual([
      expect.objectContaining({ from: 'primary', to: 'dedicated', generation: 1, waiters: 1 })
    ])
    expect(events('orca_relay_database_quiesce_expired')).toEqual([])
  })

  it('releases the held work onto the active target when until passes without a switch', async () => {
    const { database } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    database.applyPointer(pointer(quiesceFromNow('cut-2', 0, 120)))
    await sleep(10)
    const startedAt = Date.now()
    expect(await servedBy(database)).toBe('primary')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90)
    expect(events('orca_relay_database_quiesce_expired')).toEqual([
      expect.objectContaining({ id: 'cut-2' })
    ])
    expect(events('orca_relay_database_switched')).toEqual([])
    // The same window, read again on a later poll, does not hold a second time.
    database.applyPointer(pointer({ id: 'cut-2', startsAt: Date.now() - 1, until: Date.now() + 5_000 }))
    const again = Date.now()
    expect(await servedBy(database)).toBe('primary')
    expect(Date.now() - again).toBeLessThan(50)
  })

  it('finishes an in-flight transaction on the target it started on', async () => {
    const { database, primary, dedicated } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    database.applyPointer(pointer(quiesceFromNow('cut-3', 20, 2_000)))
    const inFlight = database.transaction(async (transaction) => {
      await sleep(80)
      return (await transaction.query('INSIDE'))[0]?.target
    })
    await sleep(40)
    dedicated.answer = 1
    expect(await servedBy(database)).toBe('dedicated')
    expect(await inFlight).toBe('primary')
    expect(primary.queries).toEqual(['INSIDE'])
  })

  it('never switches on timeouts or resets', async () => {
    const { database, dedicated } = setup({ primary: 0, dedicated: 'hang' })
    await database.ready()
    // A hold whose other target never answers ends on the active one.
    database.applyPointer(pointer(quiesceFromNow('cut-4', 0, 100)))
    await sleep(5)
    expect(await servedBy(database)).toBe('primary')
    expect(dedicated.probes).toBeGreaterThan(0)
    // Errors that mean lost contact, even with a higher generation waiting, leave it in place.
    dedicated.answer = 7
    for (const code of ['57014', '08006', 'ECONNRESET', '57P01']) {
      await expect(database.query(`fail:${code}`)).rejects.toMatchObject({ code })
    }
    await sleep(30)
    expect(await servedBy(database)).toBe('primary')
    expect(events('orca_relay_database_switched')).toEqual([])
  })

  it('moves a process that missed the window when its target refuses the password', async () => {
    const { database, dedicated } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    await expect(database.query('fail:28P01')).rejects.toMatchObject({ code: '28P01' })
    await sleep(20)
    // Refused, but nothing higher elsewhere: it stays.
    expect(await servedBy(database)).toBe('primary')
    dedicated.answer = 1
    await sleep(1_000)
    await expect(database.query('fail:28P01')).rejects.toMatchObject({ code: '28P01' })
    await sleep(20)
    expect(await servedBy(database)).toBe('dedicated')
  })

  it('ends the hold early when the window is cleared, after one more probe', async () => {
    const { database } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    database.applyPointer(pointer(quiesceFromNow('cut-5', 0, 5_000)))
    await sleep(5)
    const held = servedBy(database)
    await sleep(30)
    const clearedAt = Date.now()
    database.applyPointer(pointer())
    expect(await held).toBe('primary')
    expect(Date.now() - clearedAt).toBeLessThan(200)
    expect(events('orca_relay_database_quiesce_expired')).toEqual([
      expect.objectContaining({ id: 'cut-5', cleared: true })
    ])
  })

  it('selects without holding when the pointer first appears after a boot without it', async () => {
    const { database, dedicated } = setup({ primary: 0, dedicated: 1, firstPointer: null })
    expect(await servedBy(database)).toBe('primary')
    database.applyPointer(pointer())
    // Work is not held while the late selection probes.
    expect(await servedBy(database)).toBe('primary')
    await sleep(20)
    expect(await servedBy(database)).toBe('dedicated')
    expect(dedicated.probes).toBe(1)
    expect(events('orca_relay_database_target_selected').at(-1)).toMatchObject({
      target: 'dedicated',
      generation: 1,
      phase: 'pointer-appeared'
    })
  })

  it('applies the director schema to the selected target only', async () => {
    const { database, primary, dedicated } = setup({ primary: 0, dedicated: 1 })
    await database.applySchemaToActiveTarget()
    expect(dedicated.queries).toEqual(['schema'])
    expect(primary.queries).toEqual([])
  })
})
