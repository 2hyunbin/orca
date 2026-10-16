import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { markRelayDatabaseNothingRan, type RelayDatabase, type SqlRow } from './database.js'
import type { DatabaseQuiesce, DatabaseTargetPointer } from './relay-database-target-pointer.js'
import type {
  OpenedRelayDatabaseTarget,
  RelayDatabaseProbeResult,
  RelayDatabaseTarget
} from './relay-database-targets.js'
import { SwitchingRelayDatabase } from './switching-relay-database.js'

// `null` refuses the probe; `hang` never answers, like a timeout or a dead socket.
type Answer = number | null | 'hang'

type FakeTarget = RelayDatabaseTarget & {
  opened: OpenedRelayDatabaseTarget
  answer: Answer
  // Every operation's login is refused (28P01, before any statement ran).
  refuses: boolean
  // The authority table exists: a move has begun on this target.
  moveBegun: boolean
  probes: number
  openSessions: number
  // `fail:<code>` rejects with that code after running; `wait:<ms>` delays, then runs.
  queries: string[]
}

function refusal(): Error {
  const error = Object.assign(new Error('password authentication failed'), { code: '28P01' })
  markRelayDatabaseNothingRan(error)
  return error
}

function fakeTarget(name: string, answer: Answer): FakeTarget {
  const queries: string[] = []
  const run = async (sql: string): Promise<SqlRow[]> => {
    if (sql.startsWith('wait:')) await new Promise((resolve) => setTimeout(resolve, Number(sql.slice(5))))
    if (target.refuses) throw refusal()
    queries.push(sql)
    if (sql.startsWith('fail:')) {
      throw Object.assign(new Error('failed'), { code: sql.slice('fail:'.length) })
    }
    return [{ target: name }]
  }
  const database: RelayDatabase = {
    dialect: 'postgres',
    query: run,
    queryLocked: run,
    transaction: async (operation) => await operation(database),
    close: async () => undefined
  }
  const probe = async (): Promise<RelayDatabaseProbeResult | null> => {
    target.probes += 1
    const current = target.answer
    if (current === 'hang') return await new Promise(() => undefined)
    return current === null
      ? null
      : { generation: current, moveBegun: target.moveBegun, opened: target.opened }
  }
  const target: FakeTarget = {
    opened: {
      database,
      applySchema: async () => {
        if (target.refuses) throw refusal()
        queries.push('schema')
      }
    },
    answer,
    refuses: false,
    moveBegun: false,
    probes: 0,
    openSessions: 0,
    queries,
    probe,
    probeSession: () => {
      let open = false
      return {
        probe: async () => {
          const result = await probe()
          if (result && !open) {
            open = true
            target.openSessions += 1
          }
          return result
        },
        close: () => {
          if (open) target.openSessions -= 1
          open = false
        }
      }
    },
    close: async () => undefined
  }
  return target
}

const DEDICATED = {
  instanceConnectionName: 'onorca-cloud:us-central1:relay-db',
  databaseUrlSecret: 'projects/onorca-cloud/secrets/relay-db-url/versions/latest'
}

function pointer(quiesce?: DatabaseQuiesce, generation?: number): DatabaseTargetPointer {
  return {
    version: 1,
    dedicated: DEDICATED,
    ...(generation === undefined ? {} : { generation }),
    ...(quiesce ? { quiesce } : {})
  }
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
  // What the bucket holds now; a read applies it, as the control flag channel does.
  // A pointer in the bucket means a move is in progress, so both copies have the authority table.
  const moving = typeof input.firstPointer === 'object' && input.firstPointer !== null
  primary.moveBegun = input.firstPointer === undefined || moving
  dedicated.moveBegun = primary.moveBegun
  const bucket = {
    pointer: input.firstPointer === undefined ? pointer() : input.firstPointer
  }
  const database: SwitchingRelayDatabase = new SwitchingRelayDatabase({
    primary,
    openDedicated,
    firstPointer: async () => {
      const current = bucket.pointer
      if (current === 'hang') return await new Promise<null>(() => undefined)
      if (current) database.applyPointer(current)
      return current
    },
    probeTimeoutMs: 40,
    probeIntervalMs: 10,
    bootSelectionCapMs: 150,
    firstPointerWaitMs: 60,
    unavailableReprobeMs: 20
  })
  return { primary, dedicated, openDedicated, database, bucket }
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
    // One authority read, so a primary the move tool left behind is never served.
    expect(primary.probes).toBe(1)
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

  it('boots on primary, after probing through the cap, when neither target accepts', async () => {
    const { database, primary } = setup({ primary: null, dedicated: null })
    const startedAt = Date.now()
    expect(await servedBy(database)).toBe('primary')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(primary.probes).toBeGreaterThan(3)
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', generation: null, reason: 'none-eligible' })
    ])
  })

  it('never hands boot to a never-cut-over dedicated target because primary timed out', async () => {
    const { database } = setup({ primary: 'hang', dedicated: 0 })
    expect(await servedBy(database)).toBe('primary')
    const cutOver = setup({ primary: 'hang', dedicated: 1 })
    expect(await servedBy(cutOver.database)).toBe('dedicated')
  })

  it('waits for an unanswered first pointer read only briefly, then serves primary', async () => {
    const { database, primary } = setup({ primary: 0, dedicated: 0, firstPointer: 'hang' })
    const startedAt = Date.now()
    expect(await servedBy(database)).toBe('primary')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55)
    expect(Date.now() - startedAt).toBeLessThan(140)
    expect(primary.queries).toEqual(['SELECT 1'])
    expect(events('orca_relay_database_target_selected')).toEqual([
      expect.objectContaining({ target: 'primary', reason: 'no-pointer' })
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

  describe('pointer generation', () => {
    it('never boots on a target below the pointer generation, and an unknown one is not 0', async () => {
      // Primary answers 0 but the pointer says 1 was written: only dedicated at 1 is eligible.
      const fenced = setup({ primary: 0, dedicated: 1, firstPointer: pointer(undefined, 1) })
      expect(await servedBy(fenced.database)).toBe('dedicated')
      const silent = setup({ primary: 'hang', dedicated: 1, firstPointer: pointer(undefined, 1) })
      expect(await servedBy(silent.database)).toBe('dedicated')
    })

    it('keeps probing within the cap until an eligible target answers', async () => {
      const { database, dedicated } = setup({
        primary: 0,
        dedicated: 'hang',
        firstPointer: pointer(undefined, 1)
      })
      const startedAt = Date.now()
      const served = servedBy(database)
      await sleep(60)
      dedicated.answer = 1
      expect(await served).toBe('dedicated')
      expect(Date.now() - startedAt).toBeLessThan(140)
    })

    it('fails fast with no eligible target past the cap, and re-probes until one answers', async () => {
      const { database, primary, dedicated } = setup({
        primary: 0,
        dedicated: 'hang',
        firstPointer: pointer(undefined, 1)
      })
      await expect(database.query('SELECT 1')).rejects.toMatchObject({
        code: '57P03',
        message: 'relay_database_no_eligible_target'
      })
      const fastAt = Date.now()
      await expect(database.query('SELECT 1')).rejects.toMatchObject({ code: '57P03' })
      expect(Date.now() - fastAt).toBeLessThan(20)
      // Never written to the lower-generation target meanwhile.
      expect(primary.queries).toEqual([])
      dedicated.answer = 1
      await sleep(80)
      expect(await servedBy(database)).toBe('dedicated')
      expect(events('orca_relay_database_target_unavailable')).toEqual([
        expect.objectContaining({ floor: 1 })
      ])
    })

    it('re-selects when a pointer raises the generation above the serving target', async () => {
      const { database, dedicated } = setup({ primary: 0, dedicated: 0 })
      expect(await servedBy(database)).toBe('primary')
      dedicated.answer = 1
      database.applyPointer(pointer(undefined, 1))
      expect(await servedBy(database)).toBe('dedicated')
      expect(events('orca_relay_database_target_selected').at(-1)).toMatchObject({
        target: 'dedicated',
        phase: 'below-pointer-generation'
      })
    })

    it('never moves on a generation below the pointer, whatever it last remembered', async () => {
      // Primary was last read at 0 and now holds 2; the stale dedicated copy still answers 1.
      const { database, primary, dedicated } = setup({ primary: 0, dedicated: 0 })
      await database.ready()
      primary.answer = 2
      dedicated.answer = 1
      database.applyPointer(pointer(quiesceFromNow('rollback', 0, 80), 2))
      await sleep(5)
      expect(await servedBy(database)).toBe('primary')
      await expect(database.query('fail:28P01')).rejects.toMatchObject({ code: '28P01' })
      await sleep(20)
      expect(await servedBy(database)).toBe('primary')
      expect(events('orca_relay_database_switched')).toEqual([])
    })
  })

  it('keeps one marked session open on the other target through the window', async () => {
    const { database, dedicated } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    database.applyPointer(pointer(quiesceFromNow('cut-6', 0, 200)))
    await sleep(40)
    expect(dedicated.openSessions).toBe(1)
    dedicated.answer = 1
    expect(await servedBy(database)).toBe('dedicated')
    // Still open after the switch, until the window ends.
    expect(dedicated.openSessions).toBe(1)
    await sleep(200)
    expect(dedicated.openSessions).toBe(0)
  })

  it('re-selects at boot when the selected target refuses the password, schema included', async () => {
    const { database, primary, dedicated } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    primary.refuses = true
    primary.answer = null
    dedicated.answer = 1
    expect(await servedBy(database)).toBe('dedicated')
    expect(events('orca_relay_database_target_selected').at(-1)).toMatchObject({ phase: 'refused' })

    // The fence lands between the director's selection and its schema step.
    const director = setup({ primary: 0, dedicated: 'hang' })
    await director.database.ready()
    director.primary.refuses = true
    director.primary.answer = null
    const schema = director.database.applySchemaToActiveTarget()
    await sleep(30)
    director.dedicated.answer = 1
    await schema
    expect(director.dedicated.queries).toEqual(['schema'])
  })

  it('re-runs work that failed before any statement ran in the window on the new target', async () => {
    const { database, primary, dedicated } = setup({ primary: 0, dedicated: 0 })
    await database.ready()
    // Past the boot window, so only the hold can re-run it.
    await sleep(160)
    database.applyPointer(pointer(quiesceFromNow('cut-7', 20, 2_000)))
    // Started before the window; its login lands after the fence.
    const inFlight = servedBy(database, 'wait:80')
    await sleep(40)
    primary.refuses = true
    dedicated.answer = 1
    expect(await inFlight).toBe('dedicated')
    expect(dedicated.queries).toEqual(['wait:80'])
    // Work that may have run is never re-run.
    const ran = database.query('fail:57P01')
    await expect(ran).rejects.toMatchObject({ code: '57P01' })
    expect(dedicated.queries.filter((sql) => sql === 'fail:57P01')).toHaveLength(1)
  })

  describe('a move begun on primary', () => {
    it('refuses to serve without a pointer read once primary has the authority table', async () => {
      const { database, primary, bucket } = setup({ primary: 0, dedicated: 0, firstPointer: null })
      primary.moveBegun = true
      await expect(database.query('INSERT 1')).rejects.toMatchObject({ code: '57P03' })
      const fastAt = Date.now()
      await expect(database.query('INSERT 2')).rejects.toMatchObject({ code: '57P03' })
      expect(Date.now() - fastAt).toBeLessThan(20)
      expect(primary.queries).toEqual([])
      // The pointer becomes readable: it serves, on the target the pointer's rules pick.
      bucket.pointer = pointer()
      await sleep(80)
      expect(await servedBy(database)).toBe('primary')
      expect(events('orca_relay_database_pointer_required')).toEqual([
        expect.objectContaining({ reason: 'move-begun', phase: 'boot' })
      ])
    })

    it('serves primary exactly as today when it has no authority table', async () => {
      const { database, primary } = setup({ primary: 0, dedicated: 0, firstPointer: null })
      expect(await servedBy(database)).toBe('primary')
      expect(primary.probes).toBe(1)
      expect(events('orca_relay_database_pointer_required')).toEqual([])
    })

    it('never guesses when primary does not answer, and serves once it does', async () => {
      const { database, primary } = setup({ primary: 'hang', dedicated: 0, firstPointer: null })
      await expect(database.query('SELECT 1')).rejects.toMatchObject({ code: '57P03' })
      primary.answer = 0
      await sleep(120)
      expect(await servedBy(database)).toBe('primary')
    })

    // An aborted rollback leaves primary reopened while the fleet serves from dedicated.
    it('keeps a process with no pointer off a reopened primary', async () => {
      const { database, primary, dedicated, bucket } = setup({
        primary: 0,
        dedicated: 1,
        firstPointer: 'hang'
      })
      primary.moveBegun = true
      dedicated.moveBegun = true
      await expect(database.query('INSERT stray')).rejects.toMatchObject({ code: '57P03' })
      await sleep(60)
      await expect(database.query('INSERT stray')).rejects.toMatchObject({ code: '57P03' })
      expect(primary.queries).toEqual([])
      bucket.pointer = pointer(undefined, 1)
      await sleep(120)
      expect(await servedBy(database)).toBe('dedicated')
      expect(primary.queries).toEqual([])
    })

    it('resumes on primary after the move finishes, whatever floor the deleted pointer left', async () => {
      // Floor 2 with no eligible target: it fails fast and keeps probing.
      const { database, primary } = setup({
        primary: 0,
        dedicated: null,
        firstPointer: pointer(undefined, 2)
      })
      await expect(database.query('SELECT 1')).rejects.toMatchObject({ code: '57P03' })
      // finish: the pointer is deleted (a 404 keeps the last one applied) and primary's table dropped.
      primary.moveBegun = false
      await sleep(80)
      expect(await servedBy(database)).toBe('primary')
      expect(events('orca_relay_database_target_selected').at(-1)).toMatchObject({
        target: 'primary',
        reason: 'no-move'
      })
    })
  })
})
