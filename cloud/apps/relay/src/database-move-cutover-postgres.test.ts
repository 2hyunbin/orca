import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markRelayDatabaseMoveCapability } from './database.js'
import {
  copyCommand,
  installTrackingCommand,
  prepareTargetCommand,
  syncCommand,
  uninstallTrackingCommand,
  verifyCommand
} from './database-move-commands.js'
import {
  finishCommand,
  restorePasswordCommand,
  type MoveCutoverContext
} from './database-move-cutover-commands.js'
import {
  readUnmarkedRelaySessions,
  runCutover,
  type CutoverTimings
} from './database-move-cutover.js'
import { readAuthorityGeneration } from './database-move-tracking.js'
import { openPrimaryRelayDatabaseTarget } from './relay-database-targets.js'
import { SwitchingRelayDatabase } from './switching-relay-database.js'
import {
  createMoveTestSides,
  MemoryPointerStore,
  withPgClient,
  type MoveTestSides
} from './test-fixtures/database-move-sides.js'

const adminUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = adminUrl ? describe : describe.skip

// The contract's shape, scaled down: the lead still spans two pointer polls (100 ms here).
const TIMINGS: CutoverTimings = {
  leadMs: 800,
  reachableByMs: 2_000,
  quietCapMs: 3_000,
  quietScanSpacingMs: 100,
  abortAfterStartMs: 6_000,
  holdMs: 9_000
}
const POLL_MS = 100
const CELLS = ['c0', 'c1', 'c2', 'c3']

type Fleet = {
  processes: SwitchingRelayDatabase[]
  failures: unknown[]
  ackedEvents: Set<string>
  ackedIncrements: Map<string, number>
  stop: () => Promise<void>
}

// Relay processes following the pointer, three writers each doing relay-shaped work. An
// unreachable process has the wrong password for the dedicated side, as one would that cannot
// reach the new instance.
async function startFleet(
  sides: MoveTestSides,
  store: MemoryPointerStore,
  options: { unreachable?: boolean } = {}
): Promise<Fleet> {
  const count = options.unreachable ? 3 : 2
  const processes = Array.from({ length: count }, (_, index) => {
    const settings = {
      poolMax: 4,
      applicationName: markRelayDatabaseMoveCapability(
        `orca-relay/cell/p${index}`,
        `0000000${index}`
      )
    }
    const dedicatedUrl = new URL(sides.dedicated.app.url)
    if (index === 2) dedicatedUrl.password = 'not-the-password'
    const dedicated = openPrimaryRelayDatabaseTarget(dedicatedUrl.toString(), settings)
    return new SwitchingRelayDatabase({
      primary: openPrimaryRelayDatabaseTarget(sides.primary.app.url, settings),
      openDedicated: () => dedicated,
      firstPointer: async () => store.current(),
      probeIntervalMs: 50
    })
  })
  await Promise.all(processes.map((database) => database.ready()))
  const polls = processes.map((database) =>
    setInterval(() => database.applyPointer(store.current()), POLL_MS)
  )
  const fleet: Fleet = {
    processes,
    failures: [],
    ackedEvents: new Set(),
    ackedIncrements: new Map(),
    stop: async () => undefined
  }
  let stopped = false
  // Fleets in one test write distinct event ids.
  const fleetTag = Math.random().toString(36).slice(2, 8)
  const writer = async (id: number): Promise<void> => {
    const database = processes[id % processes.length]
    if (!database) return
    for (let n = 0; !stopped; n++) {
      const cell = CELLS[(id + n) % CELLS.length] ?? 'c0'
      try {
        if (n % 3 === 0) {
          const eventId = `${fleetTag}-w${id}-${n}`
          await database.query(
            `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES (?, ?, ?, ?)`,
            [eventId, Date.now(), 'move-test', '{}']
          )
          fleet.ackedEvents.add(eventId)
        } else if (n % 3 === 1) {
          await database.transaction(async (transaction) => {
            await transaction.query(
              `UPDATE relay_cells SET observed_requests = observed_requests + 1, updated_at = ? WHERE cell_id = ?`,
              [Date.now(), cell]
            )
          })
          fleet.ackedIncrements.set(cell, (fleet.ackedIncrements.get(cell) ?? 0) + 1)
        } else {
          await database.query(
            `INSERT INTO relay_rate_windows (scope_key, window_kind, window_started_at, count) VALUES (?, 'k', ?, 1)
             ON CONFLICT (scope_key, window_kind, window_started_at) DO UPDATE SET count = relay_rate_windows.count + 1`,
            [`s${id}`, Math.floor(n / 30)]
          )
        }
      } catch (error) {
        fleet.failures.push(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
  }
  const writers = Array.from({ length: count * 3 }, (_, id) => writer(id))
  fleet.stop = async () => {
    stopped = true
    await Promise.all(writers)
    for (const poll of polls) clearInterval(poll)
    await Promise.all(processes.map((database) => database.close()))
  }
  return fleet
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

// The tool's JSON log lines with this event, from the mocked console.
function moveEvents(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => {
      try {
        const parsed: unknown = JSON.parse(String(call[0]))
        return parsed
      } catch {
        return null
      }
    })
    .filter(
      (line): line is Record<string, unknown> =>
        typeof line === 'object' &&
        line !== null &&
        Reflect.get(line, 'event') === `orca_relay_move_${event}`
    )
}

async function loginCode(url: string): Promise<string | null> {
  try {
    await withPgClient(url, async () => undefined)
    return null
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'unknown'
  }
}

describePostgres('database move cutover against two PostgreSQL targets', () => {
  let sides: MoveTestSides
  let ctx: MoveCutoverContext
  let store: MemoryPointerStore

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sides = await createMoveTestSides(adminUrl ?? '')
    store = new MemoryPointerStore({
      generation: '1',
      pointer: {
        version: 1,
        dedicated: {
          instanceConnectionName: 'test-project:us-central1:relay-db',
          databaseUrlSecret: 'projects/test-project/secrets/relay-db-url/versions/latest'
        }
      }
    })
    ctx = { databases: sides.databases(), google: null, pointerStore: async () => store }
    await prepareTargetCommand(ctx)
    await installTrackingCommand(ctx, 'primary')
    await installTrackingCommand(ctx, 'dedicated')
    await withPgClient(sides.primary.app.url, async (client) => {
      for (const cell of CELLS) {
        await client.query(
          `INSERT INTO relay_cells (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
             observed_requests, last_heartbeat_at, updated_at) VALUES ($1, $2, 1, 100, 0, 0, 0, 0)`,
          [cell, `https://${cell}.relay.test`]
        )
      }
      await client.query(
        `INSERT INTO relay_audit_events (id, at, type, detail_json)
         SELECT 'seed' || n, n, 'seed', '{}' FROM generate_series(1, 500) n`
      )
    })
    await copyCommand(ctx, 'primary', { maxBytesPerSecond: 1e9 })
  }, 60_000)

  afterEach(async () => {
    ctx.databases.close()
    await sides.drop()
    vi.restoreAllMocks()
  })

  it('moves live writers to the dedicated target with no failed operation and no lost write', async () => {
    const fleet = await startFleet(sides, store)
    await new Promise((resolve) => setTimeout(resolve, 300))

    // A relay-role client without the capability mark blocks even a dry run.
    const legacy = new pg.Client({
      connectionString: sides.primary.app.url,
      application_name: 'legacy-script'
    })
    await legacy.connect()
    // Status reads it as the tool role, which sees another role's backend_type as null.
    const seen = await withPgClient(sides.primary.move.url, (client) =>
      readUnmarkedRelaySessions(client, sides.primary.app.user)
    )
    expect(seen).toEqual([{ applicationName: 'legacy-script', sessions: 1 }])
    await expect(
      runCutover({ databases: ctx.databases, to: 'dedicated', pointerStore: store, dryRun: true })
    ).rejects.toThrow('relay_sessions_without_move_capability')
    await legacy.end()
    // A login role with its own write grant would be outside the fence.
    const outsider = `${sides.primary.app.user}_outsider`
    const member = `${sides.primary.app.user}_member`
    await withPgClient(sides.primary.adminUrl, async (admin) => {
      await admin.query(`CREATE ROLE ${outsider} LOGIN`)
      await admin.query(`CREATE ROLE ${member} LOGIN NOINHERIT`)
      await admin.query(`GRANT ${sides.primary.app.user} TO ${member}`)
    })
    await withPgClient(sides.primary.app.url, (client) =>
      client.query(`GRANT UPDATE ON relay_cells TO ${outsider}`)
    )
    const refusal = await runCutover({
      databases: ctx.databases,
      to: 'dedicated',
      pointerStore: store,
      dryRun: true
    }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({
      reason: 'other_roles_can_write_relay_rows',
      details: {
        writers: [
          { role: member, via: 'set-role' },
          { role: outsider, via: 'privilege' }
        ]
      }
    })
    await withPgClient(sides.primary.adminUrl, async (admin) => {
      for (const role of [outsider, member]) {
        await admin.query(`DROP OWNED BY ${role}`)
        await admin.query(`DROP ROLE ${role}`)
      }
    })
    const before = await store.read()
    const dry = await runCutover({
      databases: ctx.databases,
      to: 'dedicated',
      pointerStore: store,
      dryRun: true
    })
    expect(dry.generation).toBe(1)
    expect(dry.hotTables).toContain('relay_cells')
    expect(await store.read()).toEqual(before)

    const cutover = runCutover({
      databases: ctx.databases,
      to: 'dedicated',
      pointerStore: store,
      timings: TIMINGS
    })
    // Still running when the window opens: the fence must wait for it rather than end it.
    const longTransaction = (async (): Promise<number> => {
      let startsAt: number | undefined
      while (startsAt === undefined) {
        startsAt = store.current()?.quiesce?.startsAt
        await sleep(10)
      }
      await sleep(startsAt - 300 - Date.now())
      await fleet.processes[0]?.transaction(async (transaction) => {
        await transaction.query(`SELECT pg_sleep(1.2)`)
        await transaction.query(
          `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('long-1', 1, 'move-test', '{}')`
        )
      })
      fleet.ackedEvents.add('long-1')
      return Date.now() - startsAt
    })()
    const result = await cutover
    const longEndedAfterStartMs = await longTransaction
    await sleep(300)
    await fleet.stop()
    const gate = moveEvents('gate_open')[0]
    expect(Number(gate?.sinceStartMs)).toBeGreaterThanOrEqual(longEndedAfterStartMs - 50)
    expect(longEndedAfterStartMs).toBeGreaterThan(800)

    expect(fleet.failures).toEqual([])
    expect(result.generation).toBe(1)
    expect(fleet.processes.map((database) => database.activeTargetName())).toEqual([
      'dedicated',
      'dedicated'
    ])
    expect(store.current()?.quiesce).toBeUndefined()
    expect(store.current()?.generation).toBe(1)
    expect(await loginCode(sides.primary.app.url)).toBe('28P01')
    // The old side is behind the pointer now; only a cutover back to it may reopen it.
    await expect(restorePasswordCommand(ctx, 'primary')).rejects.toThrow(
      'side_is_behind_the_pointer'
    )
    // Fenced: its triggers go when the old database is dropped through the Cloud SQL API.
    await expect(uninstallTrackingCommand(ctx, 'primary')).rejects.toThrow('side_is_fenced')

    const dedicated = await withPgClient(sides.dedicated.move.url, async (client) => ({
      generation: await readAuthorityGeneration(client),
      events: new Set(
        (await client.query(`SELECT id FROM relay_audit_events WHERE type = 'move-test'`)).rows.map(
          (row) => String(row.id)
        )
      ),
      cells: new Map(
        (
          await client.query(`SELECT cell_id, observed_requests::int AS n FROM relay_cells`)
        ).rows.map((row) => [String(row.cell_id), Number(row.n)])
      )
    }))
    expect(dedicated.generation).toBe(1)
    // Every acknowledged write is on the dedicated copy: synced before the switch, or written after.
    expect([...fleet.ackedEvents].filter((id) => !dedicated.events.has(id))).toEqual([])
    expect(dedicated.events.size).toBe(fleet.ackedEvents.size)
    for (const cell of CELLS)
      expect(dedicated.cells.get(cell)).toBe(fleet.ackedIncrements.get(cell) ?? 0)
    console.error(
      JSON.stringify({
        cutover: result,
        events: fleet.ackedEvents.size,
        increments: [...fleet.ackedIncrements.values()]
      })
    )

    // The old copy is no longer written by the forward direction.
    await expect(copyCommand(ctx, 'primary', {})).rejects.toThrow('target_is_the_active_side')
    // The reverse sync brings the old copy level with the new one: the rollback path.
    await syncCommand(ctx, 'dedicated', { stopAtBacklog: 0, idleMs: 5 })
    expect(await verifyCommand(ctx, {})).toBe(true)

    const reopenPrimary = async (): Promise<void> => {
      await withPgClient(adminUrl ?? '', (admin) =>
        admin.query(`ALTER ROLE ${sides.primary.app.user} PASSWORD '${sides.primary.app.password}'`)
      )
    }
    const rollback = {
      databases: ctx.databases,
      to: 'primary' as const,
      pointerStore: store,
      timings: TIMINGS,
      restoreTargetPassword: reopenPrimary
    }

    // Dedicated's tracking re-armed with writes in between: primary is no longer level with it.
    await uninstallTrackingCommand(ctx, 'dedicated')
    await withPgClient(sides.dedicated.app.url, (client) =>
      client.query(`UPDATE relay_cells SET capacity_requests = 7 WHERE cell_id = 'c0'`)
    )
    await installTrackingCommand(ctx, 'dedicated')
    await expect(runCutover({ ...rollback, dryRun: true })).rejects.toThrow('target_not_current')
    await copyCommand(ctx, 'dedicated', { restart: true, maxBytesPerSecond: 1e9 })
    expect(await loginCode(sides.primary.app.url)).toBe('28P01')

    // And back: the rollback cutover reopens the fenced primary itself, then moves the fleet.
    const returning = await startFleet(sides, store)
    await sleep(300)
    // Interrupted right after the reopen: primary is fenced again.
    await expect(
      runCutover({
        ...rollback,
        interrupted: () => moveEvents('target_password_restored').length > 0
      })
    ).rejects.toThrow('interrupted')
    expect(await loginCode(sides.primary.app.url)).toBe('28P01')
    expect(store.current()?.quiesce).toBeUndefined()

    // Even with primary's login open again (as during a reopen), a process that cannot read the
    // pointer does not write there: primary has the authority table, so a move has begun.
    await reopenPrimary()
    const blindSettings = {
      poolMax: 2,
      applicationName: markRelayDatabaseMoveCapability('orca-relay/cell/blind', '0000000b')
    }
    const blind = new SwitchingRelayDatabase({
      primary: openPrimaryRelayDatabaseTarget(sides.primary.app.url, blindSettings),
      openDedicated: () => openPrimaryRelayDatabaseTarget(sides.dedicated.app.url, blindSettings),
      firstPointer: async () => null,
      firstPointerWaitMs: 200
    })
    await expect(
      blind.query(
        `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('blind-1', 1, 't', '{}')`
      )
    ).rejects.toMatchObject({ code: '57P03' })
    await blind.close()
    const blindRows = await withPgClient(sides.primary.move.url, (client) =>
      client.query(`SELECT 1 FROM relay_audit_events WHERE id = 'blind-1'`)
    )
    expect(blindRows.rows).toEqual([])

    const back = await runCutover(rollback)
    await sleep(300)
    await returning.stop()
    expect(returning.failures).toEqual([])
    expect(back.generation).toBe(2)
    expect(returning.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary'
    ])
    expect(store.current()?.generation).toBe(2)
    expect(await loginCode(sides.dedicated.app.url)).toBe('28P01')

    // Finish, keeping primary: only the serving side can be kept. Afterwards a process with no
    // pointer serves DATABASE_URL exactly as before the move.
    await expect(finishCommand(ctx, 'dedicated', { pointerDrainMs: 0 })).rejects.toThrow(
      'kept_side_is_not_serving'
    )
    // Under a live fleet: every step leaves primary eligible, so no operation fails.
    const finishing = await startFleet(sides, store)
    await sleep(300)
    await finishCommand(ctx, 'primary', { pointerDrainMs: 4 * POLL_MS })
    await sleep(300)
    await finishing.stop()
    expect(finishing.failures).toEqual([])
    expect(finishing.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary'
    ])
    expect(store.current()).toBeNull()
    const after = await withPgClient(sides.primary.app.url, (client) =>
      client.query(
        `SELECT to_regclass('relay_database_authority') IS NULL AS gone,
           to_regclass('relay_move_dirty') IS NULL AS untracked`
      )
    )
    expect(after.rows[0]).toEqual({ gone: true, untracked: true })
    const settings = {
      poolMax: 2,
      applicationName: markRelayDatabaseMoveCapability('orca-relay/cell/after', '0000000a')
    }
    const plain = new SwitchingRelayDatabase({
      primary: openPrimaryRelayDatabaseTarget(sides.primary.app.url, settings),
      openDedicated: () => openPrimaryRelayDatabaseTarget(sides.dedicated.app.url, settings),
      firstPointer: async () => null,
      firstPointerWaitMs: 200
    })
    await plain.query(
      `INSERT INTO relay_audit_events (id, at, type, detail_json) VALUES ('after-finish', 1, 't', '{}')`
    )
    expect(plain.activeTargetName()).toBe('primary')
    await plain.close()
  }, 90_000)

  it('keeps primary serving when the fencing session dies before the abort', async () => {
    // A row only the target has makes the comparison fail after the fence.
    await withPgClient(sides.dedicated.move.url, (client) =>
      client.query(
        `INSERT INTO relay_cells (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
           observed_requests, last_heartbeat_at, updated_at) VALUES ('ghost', 'https://ghost', 0, 0, 0, 0, 0, 0)`
      )
    )
    const fleet = await startFleet(sides, store)
    await sleep(300)
    // The fencing session is killed as soon as the fence lands, so undo cannot use it.
    const killer = setInterval(() => {
      if (moveEvents('fence_complete').length === 0) return
      void withPgClient(sides.primary.adminUrl, (admin) =>
        admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE application_name LIKE 'orca-relay-move/cutover-fence%'`
        )
      )
    }, 5)
    let restoredThroughApi = 0
    await expect(
      runCutover({
        databases: ctx.databases,
        to: 'dedicated',
        pointerStore: store,
        timings: TIMINGS,
        // Stands in for the Cloud SQL Admin API restore.
        restoreSourcePassword: async () => {
          restoredThroughApi += 1
          await withPgClient(adminUrl ?? '', (admin) =>
            admin.query(
              `ALTER ROLE ${sides.primary.app.user} PASSWORD '${sides.primary.app.password}'`
            )
          )
        }
      })
    ).rejects.toThrow()
    clearInterval(killer)
    await sleep(500)
    await fleet.stop()
    expect(restoredThroughApi).toBe(1)
    expect(fleet.failures).toEqual([])
    expect(fleet.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary'
    ])
    expect(store.current()?.quiesce).toBeUndefined()
    expect(await loginCode(sides.primary.app.url)).toBeNull()
    // Processes that start now still serve primary.
    const restarted = await startFleet(sides, store)
    await sleep(500)
    await restarted.stop()
    expect(restarted.failures).toEqual([])
    expect(restarted.ackedEvents.size).toBeGreaterThan(0)
  }, 60_000)

  it('aborts when a process cannot reach the target, naming it, with no failed operation', async () => {
    const fleet = await startFleet(sides, store, { unreachable: true })
    await sleep(300)
    const refusal = await runCutover({
      databases: ctx.databases,
      to: 'dedicated',
      pointerStore: store,
      timings: TIMINGS
    }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({
      reason: 'processes_without_a_target_session',
      details: { ids: ['00000002'] }
    })
    await sleep(500)
    await fleet.stop()
    expect(fleet.failures).toEqual([])
    expect(fleet.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary',
      'primary'
    ])
    expect(store.current()?.quiesce).toBeUndefined()
    expect(store.current()?.generation).toBeUndefined()
    expect(await loginCode(sides.primary.app.url)).toBeNull()
  }, 60_000)

  it('aborts when a process has sessions only on the target, naming it', async () => {
    const fleet = await startFleet(sides, store)
    await sleep(300)
    // A marked relay process seen on the target but with no session on the source.
    const stray = new pg.Client({
      connectionString: sides.dedicated.app.url,
      application_name: markRelayDatabaseMoveCapability('orca-relay/cell/stray', '0000000f')
    })
    await stray.connect()
    const refusal = await runCutover({
      databases: ctx.databases,
      to: 'dedicated',
      pointerStore: store,
      timings: TIMINGS
    }).catch((error: unknown) => error)
    await stray.end()
    expect(refusal).toMatchObject({
      reason: 'processes_only_on_the_target',
      details: { ids: ['0000000f'] }
    })
    await sleep(500)
    await fleet.stop()
    expect(fleet.failures).toEqual([])
    expect(fleet.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary'
    ])
    expect(store.current()?.quiesce).toBeUndefined()
    expect(await loginCode(sides.primary.app.url)).toBeNull()
  }, 60_000)

  it('refuses a dry run whose copy predates the current tracking', async () => {
    await uninstallTrackingCommand(ctx, 'primary')
    await withPgClient(sides.primary.app.url, (client) =>
      client.query(`UPDATE relay_audit_events SET at = -at WHERE type = 'seed'`)
    )
    await installTrackingCommand(ctx, 'primary')
    const dryRun = {
      databases: ctx.databases,
      to: 'dedicated' as const,
      pointerStore: store,
      dryRun: true
    }
    await expect(runCutover(dryRun)).rejects.toThrow('copy_predates_tracking')
    await copyCommand(ctx, 'primary', { restart: true, maxBytesPerSecond: 1e9 })
    await expect(runCutover(dryRun)).resolves.toMatchObject({ dryRun: true })
    expect(await verifyCommand(ctx, {})).toBe(true)
  }, 60_000)

  it('refuses a dry run after one table lost its triggers and was tracked again', async () => {
    await withPgClient(sides.primary.app.url, async (client) => {
      for (const suffix of ['ins', 'upd', 'del', 'trunc']) {
        await client.query(`DROP TRIGGER relay_move_track_${suffix} ON relay_cells`)
      }
      await client.query(`UPDATE relay_cells SET capacity_requests = 9`)
    })
    await installTrackingCommand(ctx, 'primary')
    await expect(
      runCutover({ databases: ctx.databases, to: 'dedicated', pointerStore: store, dryRun: true })
    ).rejects.toThrow('copy_predates_tracking')
  }, 60_000)

  it('aborts on a hot-table difference and leaves the processes on the restored source', async () => {
    // A row only the dedicated copy has, written by the tool role so no trigger marks it.
    await withPgClient(sides.dedicated.move.url, async (client) => {
      await client.query(
        `INSERT INTO relay_cells (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
           observed_requests, last_heartbeat_at, updated_at) VALUES ('ghost', 'https://ghost', 0, 0, 0, 0, 0, 0)`
      )
    })
    const fleet = await startFleet(sides, store)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(
      runCutover({
        databases: ctx.databases,
        to: 'dedicated',
        pointerStore: store,
        timings: TIMINGS
      })
    ).rejects.toThrow('hot_tables_differ')
    const ackedAtAbort = fleet.ackedEvents.size
    await new Promise((resolve) => setTimeout(resolve, 500))
    await fleet.stop()

    expect(fleet.failures).toEqual([])
    expect(fleet.ackedEvents.size).toBeGreaterThan(ackedAtAbort)
    expect(fleet.processes.map((database) => database.activeTargetName())).toEqual([
      'primary',
      'primary'
    ])
    expect(store.current()?.quiesce).toBeUndefined()
    expect(await loginCode(sides.primary.app.url)).toBeNull()
    const generation = await withPgClient(sides.dedicated.move.url, (client) =>
      readAuthorityGeneration(client)
    )
    expect(generation).toBe(0)
  }, 60_000)
})
