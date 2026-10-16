import pg from 'pg'
import {
  compareMoveSchemas,
  RELAY_DATABASE_AUTHORITY_TABLE,
  quoteIdent,
  readMoveTables,
  tableRef,
  type MoveTable
} from './database-move-catalog.js'
import {
  endQuietly,
  otherMoveSide,
  type MoveDatabases,
  type MoveSide
} from './database-move-connections.js'
import { describeMoveError, logMoveEvent, MoveRefusal, sleep } from './database-move-events.js'
import { fenceWithSession, setOwnPassword, terminateOtherSessions } from './database-move-fence.js'
import {
  PointerGenerationConflict,
  type DatabaseTargetPointerStore,
  type StoredDatabaseTargetPointer
} from './database-move-pointer-store.js'
import {
  replayClaims,
  requireCurrentCopy,
  runSyncLoop,
  syncBatch,
  takeSyncLock,
  type MoveSyncSessions
} from './database-move-sync.js'
import {
  readTrackingArm,
  MOVE_CLAIMED_TABLE,
  MOVE_COPY_PROGRESS_TABLE,
  readAuthorityGeneration,
  readDirtyBacklog,
  readTrackingState
} from './database-move-tracking.js'
import { verifyMoveTables, verdictsEqual } from './database-move-verify.js'
import { RELAY_DATABASE_MOVE_CAPABILITY_SUFFIX } from './database.js'
import {
  DATABASE_QUIESCE_MAX_MS,
  type DatabaseTargetPointer
} from './relay-database-target-pointer.js'

// Contract timings. Processes poll the pointer every 5 s, so 12 s of lead gives each two reads.
export type CutoverTimings = {
  leadMs: number
  // Every marked process must have a session on the target by then, or the cutover aborts.
  reachableByMs: number
  // The fence waits for the source's relay sessions to go quiet, but no longer than this.
  quietCapMs: number
  quietScanSpacingMs: number
  abortAfterStartMs: number
  holdMs: number
}
export const CUTOVER_TIMINGS: CutoverTimings = {
  leadMs: 12_000,
  reachableByMs: 5_000,
  quietCapMs: 6_000,
  quietScanSpacingMs: 100,
  abortAfterStartMs: 15_000,
  holdMs: DATABASE_QUIESCE_MAX_MS
}

const MARKED_PROCESS = new RegExp(`${RELAY_DATABASE_MOVE_CAPABILITY_SUFFIX}([0-9a-f]{8})$`)
const BUSY_STATES = new Set(['active', 'idle in transaction', 'idle in transaction (aborted)'])
const TOOL_APPLICATION_PREFIX = 'orca-relay-move/'

export type CutoverInput = {
  databases: MoveDatabases
  to: MoveSide
  pointerStore: DatabaseTargetPointerStore
  dryRun?: boolean
  // The catch-up sync must bring the source's dirty set to at most this before the window opens.
  maxBacklog?: number
  // Tables with at most this many rows are compared in full after the drain.
  hotTableMaxRows?: number
  timings?: Partial<CutoverTimings>
  // When the held session is gone: the Cloud SQL Admin API restore for the source.
  restoreSourcePassword?: () => Promise<void>
  // A rollback's target was fenced by the cutover that left it; reopened just before the window.
  restoreTargetPassword?: () => Promise<void>
  // SIGTERM: stop at the next step and undo, unless authority already moved.
  interrupted?: () => boolean
}

export type CutoverResult = {
  from: MoveSide
  to: MoveSide
  dryRun: boolean
  generation: number
  hotTables: string[]
  heldMs?: number
  terminated?: number
}

// Every relay-role session except the caller's, with names lacking the capability mark. Another
// role sees backend_type as null, so null counts as a client.
export async function readUnmarkedRelaySessions(
  client: pg.Client,
  appUser: string
): Promise<Array<{ applicationName: string; sessions: number }>> {
  const result = await client.query(
    `SELECT application_name, count(*)::int AS sessions FROM pg_stat_activity
     WHERE usename = $1 AND coalesce(backend_type, 'client backend') = 'client backend'
       AND pid <> pg_backend_pid() AND application_name !~ $2
     GROUP BY application_name ORDER BY application_name`,
    [appUser, MARKED_PROCESS.source]
  )
  return result.rows.map((row) => ({
    applicationName: String(row.application_name),
    sessions: Number(row.sessions)
  }))
}

// Run as the relay role on that side, so other relay sessions' names and states are visible.
// The tool's own sessions are left out.
async function readRelayProcesses(
  client: pg.Client,
  appUser: string
): Promise<{ ids: Set<string>; busy: Array<{ applicationName: string; state: string }> }> {
  const result = await client.query(
    `SELECT application_name, coalesce(state, '') AS state FROM pg_stat_activity
     WHERE usename = $1 AND backend_type = 'client backend' AND pid <> pg_backend_pid()
       AND left(application_name, $3) <> $2`,
    [appUser, TOOL_APPLICATION_PREFIX, TOOL_APPLICATION_PREFIX.length]
  )
  const ids = new Set<string>()
  const busy: Array<{ applicationName: string; state: string }> = []
  for (const row of result.rows) {
    const applicationName = String(row.application_name)
    const id = MARKED_PROCESS.exec(applicationName)?.[1]
    if (id) ids.add(id)
    if (BUSY_STATES.has(String(row.state))) busy.push({ applicationName, state: String(row.state) })
  }
  return { ids, busy }
}

async function countClaimed(client: pg.Client): Promise<number> {
  const result = await client.query(`SELECT count(*)::int AS n FROM ${MOVE_CLAIMED_TABLE}`)
  return Number(result.rows[0]?.n ?? 0)
}

async function hotTables(
  client: pg.Client,
  tables: MoveTable[],
  maxRows: number
): Promise<MoveTable[]> {
  const hot: MoveTable[] = []
  for (const table of tables) {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${tableRef(table)} LIMIT $1) t`,
      [maxRows + 1]
    )
    if (Number(result.rows[0]?.n) <= maxRows) hot.push(table)
  }
  return hot
}

function withoutQuiesce(pointer: DatabaseTargetPointer): DatabaseTargetPointer {
  const { quiesce: _cleared, ...rest } = pointer
  return rest
}

// Rewrites the pointer while it still carries our window, re-reading once if its generation
// moved (or a write was never confirmed). A window someone else replaced is left alone, and
// processes release at `until` on their own if this never lands.
async function updateOurPointer(
  store: DatabaseTargetPointerStore,
  quiesceId: string,
  known: StoredDatabaseTargetPointer | null,
  change: (pointer: DatabaseTargetPointer) => DatabaseTargetPointer
): Promise<StoredDatabaseTargetPointer | null> {
  try {
    if (!known) throw new PointerGenerationConflict()
    const pointer = change(known.pointer)
    return { pointer, generation: await store.write(pointer, known.generation) }
  } catch (error) {
    if (!(error instanceof PointerGenerationConflict)) throw error
    const current = await store.read()
    if (current?.pointer.quiesce?.id !== quiesceId) {
      logMoveEvent('pointer_window_not_ours', { id: quiesceId })
      return null
    }
    const pointer = change(current.pointer)
    return { pointer, generation: await store.write(pointer, current.generation) }
  }
}

async function clearQuiesce(
  store: DatabaseTargetPointerStore,
  quiesceId: string,
  known: StoredDatabaseTargetPointer | null,
  generation?: number
): Promise<void> {
  const cleared = await updateOurPointer(store, quiesceId, known, (pointer) => ({
    ...withoutQuiesce(pointer),
    ...(generation === undefined
      ? {}
      : { generation: Math.max(pointer.generation ?? 0, generation) })
  }))
  if (cleared) logMoveEvent('quiesce_cleared', { id: quiesceId })
}

// Login roles other than the relay's and the tool's that can write relay rows, or become the relay
// role. The fence only covers sessions logged in as the relay role, so any of these could write
// the source after the drain.
async function readOtherRelayWriters(
  client: pg.Client,
  tables: MoveTable[],
  appUser: string,
  exclude: string[]
): Promise<Array<{ role: string; via: 'privilege' | 'set-role' }>> {
  // Before 16, any membership allows SET ROLE; from 16 an ADMIN-only grant does not.
  const version = Number(
    (await client.query('SHOW server_version_num')).rows[0]?.server_version_num
  )
  const membership = version >= 160_000 ? 'SET' : 'MEMBER'
  const result = await client.query(
    `SELECT r.rolname,
       CASE WHEN pg_has_role(r.oid, $3::regrole, '${membership}') THEN 'set-role' ELSE 'privilege' END AS via
     FROM pg_roles r
     WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> ALL($2::text[])
       AND (pg_has_role(r.oid, $3::regrole, '${membership}')
         OR EXISTS (SELECT 1 FROM unnest($1::text[]) t(name)
                    WHERE has_table_privilege(r.oid, format('public.%I', t.name), 'INSERT, UPDATE, DELETE')))
     ORDER BY 1`,
    [tables.map((table) => table.name), [appUser, ...exclude], quoteIdent(appUser)]
  )
  return result.rows.map((row) => ({
    role: String(row.rolname),
    via: row.via === 'set-role' ? 'set-role' : 'privilege'
  }))
}

async function sleepUnless(until: number, interrupted: () => boolean): Promise<void> {
  while (Date.now() < until && !interrupted()) await sleep(Math.min(100, until - Date.now()))
}

// Added to the lead, so the window still starts at least the contract's lead after the write lands.
const POINTER_WRITE_SLACK_MS = 2_000

// The contract's cutover: quiesce, fence the source, drain, compare the hot tables, raise the
// target's authority generation, clear. Anything that fails before the authority write restores
// the source's password over the held session and clears the window, so processes resume where
// they were. Nothing changes in a dry run.
export async function runCutover(input: CutoverInput): Promise<CutoverResult> {
  const timings = { ...CUTOVER_TIMINGS, ...input.timings }
  const from = otherMoveSide(input.to)
  const to = input.to
  const dryRun = input.dryRun ?? false
  const interrupted = input.interrupted ?? (() => false)
  const { databases } = input
  logMoveEvent('cutover_started', { from, to, dryRun })
  const opened: pg.Client[] = []
  const open = async (
    side: MoveSide,
    role: 'app' | 'move',
    purpose: string
  ): Promise<pg.Client> => {
    const client = await databases.connect(side, role, purpose)
    opened.push(client)
    return client
  }
  const checkpoint = (): void => {
    if (interrupted()) throw new MoveRefusal('interrupted')
  }
  let phase = 'preconditions'
  let fenced = false
  let quiesceId: string | null = null
  let written: StoredDatabaseTargetPointer | null = null
  let committed = false
  // Unknown after a lost reply: the pointer's generation is then left for the operator.
  let authorityConfirmed = false
  let heldSession: pg.Client | null = null
  let targetSession: pg.Client | null = null
  let targetReopened = false
  let newGeneration = 0
  try {
    const sourceLogin = await databases.login(from, 'app')
    const toolUsers = [
      (await databases.login(from, 'move')).user,
      (await databases.login(to, 'move')).user
    ]
    const held = await open(from, 'app', 'cutover-fence')
    heldSession = held
    const sessions: MoveSyncSessions = {
      source: await open(from, 'move', 'cutover-sync'),
      target: await open(to, 'move', 'cutover-sync')
    }
    // The processes will log in there next; prove the relay's password works first. The session
    // stays open to see which processes reach the target during the window.
    let targetApp = await open(to, 'app', 'cutover-gate').catch((error: unknown) => error)
    const refusedPassword =
      typeof targetApp === 'object' &&
      targetApp !== null &&
      'code' in targetApp &&
      targetApp.code === '28P01'
    let targetPasswordRestore: 'not-needed' | 'needed' = 'not-needed'
    if (!(targetApp instanceof pg.Client)) {
      if (!refusedPassword || !input.restoreTargetPassword) {
        throw new MoveRefusal('target_refuses_relay_login', describeMoveError(targetApp))
      }
      targetPasswordRestore = 'needed'
    }

    const tables = await readMoveTables(sessions.source)
    const targetTables = await readMoveTables(sessions.target)
    await compareMoveSchemas(
      { client: sessions.source, tables },
      { client: sessions.target, tables: targetTables }
    )
    for (const [side, client] of [
      [from, sessions.source],
      [to, sessions.target]
    ] as const) {
      const tracking = await readTrackingState(client, tables)
      if (!tracking.sentinel || tracking.untracked.length > 0) {
        throw new MoveRefusal('tracking_incomplete', { side, ...tracking })
      }
    }
    await takeSyncLock(sessions.source)
    // A dead syncer's claimed keys are off the dirty set; the drain must count them.
    const claimed = await countClaimed(sessions.source)
    if (claimed > 0 && !dryRun) await replayClaims(sessions, tables)
    const [sourceGeneration, targetGeneration] = await Promise.all([
      readAuthorityGeneration(sessions.source),
      readAuthorityGeneration(sessions.target)
    ])
    // Processes pick the higher generation; a tie goes to primary.
    const primaryGeneration = from === 'primary' ? sourceGeneration : targetGeneration
    const dedicatedGeneration = from === 'dedicated' ? sourceGeneration : targetGeneration
    const active: MoveSide = dedicatedGeneration > primaryGeneration ? 'dedicated' : 'primary'
    if (active !== from) throw new MoveRefusal('source_is_not_the_active_target', { active })
    const targetBacklog = await readDirtyBacklog(sessions.target)
    if (targetBacklog > 0) throw new MoveRefusal('target_has_relay_writes', { targetBacklog })
    const stored = await input.pointerStore.read()
    if (!stored) throw new MoveRefusal('pointer_absent')
    if (stored.pointer.quiesce && stored.pointer.quiesce.until > Date.now()) {
      throw new MoveRefusal('quiesce_already_open', { id: stored.pointer.quiesce.id })
    }
    const dedicatedInstance = (await databases.login('dedicated', 'app')).instanceConnectionName
    if (
      dedicatedInstance &&
      dedicatedInstance !== stored.pointer.dedicated.instanceConnectionName
    ) {
      throw new MoveRefusal('pointer_names_another_instance')
    }
    const hot = await hotTables(sessions.source, tables, input.hotTableMaxRows ?? 5_000)
    const generation = Math.max(sourceGeneration, targetGeneration) + 1
    newGeneration = generation
    const maxBacklog = input.maxBacklog ?? 2_000
    if (!dryRun) {
      phase = 'catch-up'
      await runSyncLoop(sessions, tables, {
        stopAtBacklog: maxBacklog,
        deadline: Date.now() + 600_000,
        shouldStop: interrupted,
        label: { phase }
      })
      checkpoint()
    }
    // A copy made before tracking was last installed missed the changes in between.
    await requireCurrentCopy(sessions, tables, 'apply')
    // Recorded with the authority, so a move back can tell the copy kept in step.
    const targetArm = await readTrackingArm(sessions.target)
    if (to === 'dedicated') {
      // The dedicated copy got its rows from `copy`; a stopped one would leave big tables short.
      const progress = await sessions.target.query(
        `SELECT table_name FROM ${MOVE_COPY_PROGRESS_TABLE} WHERE done`
      )
      const done = new Set(progress.rows.map((row) => String(row.table_name)))
      const uncopied = tables.filter((table) => !done.has(table.name)).map((table) => table.name)
      if (uncopied.length > 0) throw new MoveRefusal('copy_incomplete', { tables: uncopied })
    }
    // Checked last, just before the window, so a client that connected during the catch-up counts.
    const writers = await readOtherRelayWriters(held, tables, sourceLogin.user, toolUsers)
    if (writers.length > 0) throw new MoveRefusal('other_roles_can_write_relay_rows', { writers })
    if (targetPasswordRestore === 'needed' && !dryRun && input.restoreTargetPassword) {
      phase = 'reopen-target'
      // From here an abort must fence the target again: it is below the pointer's generation, so
      // no process may serve it, but its login is open.
      targetReopened = true
      await input.restoreTargetPassword()
      logMoveEvent('target_password_restored', { side: to })
      const reopenedSession = await open(to, 'app', 'cutover-gate')
      targetApp = reopenedSession
      targetSession = reopenedSession
    }
    const unmarked = await readUnmarkedRelaySessions(held, sourceLogin.user)
    if (unmarked.length > 0) {
      throw new MoveRefusal('relay_sessions_without_move_capability', { sessions: unmarked })
    }
    const backlog = await readDirtyBacklog(sessions.source)
    const facts = {
      generation,
      backlog,
      claimed,
      targetPasswordRestore,
      hotTables: hot.map((table) => table.name)
    }
    if (backlog > maxBacklog) throw new MoveRefusal('backlog_too_large', { backlog, maxBacklog })
    logMoveEvent('cutover_preconditions_met', { ...facts, sourceGeneration, targetGeneration })
    if (dryRun) return { from, to, dryRun, generation, hotTables: facts.hotTables }

    phase = 'quiesce'
    const startsAt = Date.now() + timings.leadMs + POINTER_WRITE_SLACK_MS
    const quiesce = { id: `cutover-${to}-${startsAt}`, startsAt, until: startsAt + timings.holdMs }
    const pointer = { ...stored.pointer, quiesce }
    quiesceId = quiesce.id
    written = { pointer, generation: await input.pointerStore.write(pointer, stored.generation) }
    logMoveEvent('quiesce_written', { ...quiesce })
    if (startsAt - Date.now() < timings.leadMs) {
      throw new MoveRefusal('pointer_write_too_slow_for_the_lead')
    }
    const abortAt = startsAt + timings.abortAfterStartMs
    // Keep the backlog small through the lead; the drain after the fence is then short.
    await runSyncLoop(sessions, tables, {
      shouldStop: () => Date.now() >= startsAt || interrupted(),
      idleMs: 50,
      label: { phase }
    })
    await sleepUnless(startsAt, interrupted)
    checkpoint()

    phase = 'gate'
    if (!(targetApp instanceof pg.Client)) throw new MoveRefusal('target_session_missing')
    const gateApp = targetApp
    const targetUser = (await databases.login(to, 'app')).user
    // Fence only once every process seen on the source also holds a session on the target (it can
    // log in there), and the source's relay sessions have finished their work: no statement
    // running and no transaction open, on two scans in a row.
    let quietScans = 0
    for (;;) {
      checkpoint()
      const [onSource, onTarget] = await Promise.all([
        readRelayProcesses(held, sourceLogin.user),
        readRelayProcesses(gateApp, targetUser)
      ])
      const missing = [...onSource.ids].filter((id) => !onTarget.ids.has(id)).sort()
      // Seen only on the target: a process with no old-side session to read, which the fence
      // cannot vouch for (it could reach a reopened old side later).
      const targetOnly = [...onTarget.ids].filter((id) => !onSource.ids.has(id)).sort()
      quietScans = onSource.busy.length === 0 ? quietScans + 1 : 0
      const sinceStart = Date.now() - startsAt
      if (missing.length > 0 && sinceStart >= timings.reachableByMs) {
        throw new MoveRefusal('processes_without_a_target_session', { ids: missing })
      }
      if (targetOnly.length > 0 && sinceStart >= timings.reachableByMs) {
        throw new MoveRefusal('processes_only_on_the_target', { ids: targetOnly })
      }
      const reachable = missing.length === 0 && targetOnly.length === 0
      if (reachable && quietScans >= 2) {
        logMoveEvent('gate_open', { processes: onSource.ids.size, sinceStartMs: sinceStart })
        break
      }
      if (reachable && sinceStart >= timings.quietCapMs) {
        logMoveEvent('gate_cap_reached', { busy: onSource.busy, sinceStartMs: sinceStart })
        break
      }
      await syncBatch(sessions, tables, 500)
      await sleep(timings.quietScanSpacingMs)
    }

    phase = 'fence'
    fenced = true
    const fence = await fenceWithSession(held)
    let terminated = fence.terminated
    // Drain, compare, then scan once more: a login that was mid-authentication at the fence
    // shows up only now, and anything it wrote must be drained again.
    for (let round = 1; ; round++) {
      phase = 'drain'
      const drained = await runSyncLoop(sessions, tables, {
        stopAtBacklog: 0,
        deadline: abortAt,
        idleMs: 10,
        shouldStop: interrupted,
        label: { phase }
      })
      checkpoint()
      logMoveEvent('drained', { keys: drained.keys, round })
      phase = 'compare'
      const verdicts = await verifyMoveTables(sessions.source, sessions.target, hot, {
        chunkRows: 1_000_000
      })
      if (!verdictsEqual(verdicts)) {
        throw new MoveRefusal('hot_tables_differ', {
          tables: verdicts
            .filter((verdict) => verdict.mismatches.length > 0)
            .map((verdict) => verdict.table)
        })
      }
      const late = await terminateOtherSessions(held)
      terminated += late.terminated
      if (late.terminated === 0) break
      if (round >= 3) throw new MoveRefusal('relay_sessions_keep_reappearing')
    }
    checkpoint()
    if (Date.now() >= abortAt) throw new MoveRefusal('abort_bar_passed')

    phase = 'authority'
    try {
      await sessions.target.query(
        `INSERT INTO ${RELAY_DATABASE_AUTHORITY_TABLE}
           (singleton, generation, written_at, tracking_arm)
         VALUES (TRUE, $1, $2, $3)
         ON CONFLICT (singleton) DO UPDATE SET generation = EXCLUDED.generation,
           written_at = EXCLUDED.written_at, tracking_arm = EXCLUDED.tracking_arm`,
        [generation, Date.now(), targetArm]
      )
    } catch (error) {
      // A lost reply may hide a commit. Undo only on proof that it did not land.
      const verdict = await checkAuthorityWrite(databases, to, generation, quiesce.until)
      committed = verdict !== 'unwritten'
      authorityConfirmed = verdict === 'written'
      throw error
    }
    committed = true
    authorityConfirmed = true
    logMoveEvent('authority_written', { side: to, generation })

    // Recorded before the window clears: from here no side below this generation may serve or be
    // reopened (restore-password refuses it).
    phase = 'pointer-generation'
    written =
      (await updateOurPointer(input.pointerStore, quiesce.id, written, (current) => ({
        ...current,
        generation: Math.max(current.generation ?? 0, generation)
      }))) ?? written
    logMoveEvent('pointer_generation_written', { generation })

    phase = 'clear'
    await clearQuiesce(input.pointerStore, quiesce.id, written, generation)
    const heldMs = Date.now() - startsAt
    logMoveEvent('cutover_complete', { from, to, generation, heldMs, terminated })
    return { from, to, dryRun, generation, hotTables: facts.hotTables, heldMs, terminated }
  } catch (error) {
    logMoveEvent(committed ? 'cutover_finish_failed' : 'cutover_aborted', {
      phase,
      ...describeMoveError(error),
      ...(committed && phase === 'authority'
        ? {
            authority: 'possibly-written',
            undo: 'skipped',
            recover: `run status; if ${to} shows generation ${newGeneration} nothing is needed, else restore-password --side ${from}`
          }
        : {})
    })
    if (!committed) {
      await undoCutover(input, {
        held: heldSession,
        fenced,
        quiesceId,
        written,
        target: targetReopened ? targetSession : null,
        reopened: targetReopened
      })
    } else if (quiesceId) {
      const recorded = authorityConfirmed ? newGeneration : undefined
      await clearQuiesce(input.pointerStore, quiesceId, written, recorded).catch(
        (clearError: unknown) => logMoveEvent('quiesce_clear_failed', describeMoveError(clearError))
      )
    }
    throw error
  } finally {
    await Promise.all(opened.map((client) => endQuietly(client)))
  }
}

// The lock waits out an INSERT still committing (a synchronous standby, a lost reply), so the read
// after it is final. Retried until the window would end; an answer never reached is "maybe".
async function checkAuthorityWrite(
  databases: MoveDatabases,
  side: MoveSide,
  generation: number,
  until: number
): Promise<'written' | 'unwritten' | 'unknown'> {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await databases.connect(side, 'move', 'cutover-authority-check')
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL lock_timeout = '5s'`)
        await client.query(
          `LOCK TABLE ${RELAY_DATABASE_AUTHORITY_TABLE} IN SHARE ROW EXCLUSIVE MODE`
        )
        const unwritten = (await readAuthorityGeneration(client)) < generation
        await client.query('ROLLBACK')
        logMoveEvent('authority_checked', { side, written: !unwritten, attempt })
        return unwritten ? 'unwritten' : 'written'
      } finally {
        await endQuietly(client)
      }
    } catch (error) {
      logMoveEvent('authority_check_failed', { side, attempt, ...describeMoveError(error) })
      if (Date.now() + 1_000 >= until) return 'unknown'
      await sleep(Math.min(1_000 * attempt, until - Date.now() - 1_000))
    }
  }
}

// Over the cutover's session if it still works, else a fresh one: the target's login is open
// right now, so a new relay-role session can still log in to close it.
async function fenceReopenedTarget(input: CutoverInput, shared: pg.Client | null): Promise<void> {
  const side = input.to
  for (const attempt of ['shared', 'fresh'] as const) {
    let session: pg.Client | null = null
    try {
      session =
        attempt === 'shared'
          ? shared
          : await input.databases.connect(side, 'app', 'cutover-refence')
      if (!session) continue
      await fenceWithSession(session)
      logMoveEvent('target_fenced_again', { side, session: attempt })
      return
    } catch (error) {
      logMoveEvent('target_refence_failed', { side, session: attempt, ...describeMoveError(error) })
    } finally {
      if (attempt === 'fresh') await endQuietly(session)
    }
  }
  logMoveEvent('target_left_open', { side, run: `fence --side ${side}` })
}

async function undoCutover(
  input: CutoverInput,
  undo: {
    held: pg.Client | null
    fenced: boolean
    quiesceId: string | null
    written: StoredDatabaseTargetPointer | null
    // Set when a rollback reopened its target: the relay-role session to fence it again with.
    target: pg.Client | null
    reopened: boolean
  }
): Promise<void> {
  const from = otherMoveSide(input.to)
  const { held, fenced, quiesceId, written } = undo
  if (undo.reopened) await fenceReopenedTarget(input, undo.target)
  if (fenced) {
    try {
      if (!held) throw new MoveRefusal('held_session_missing')
      await setOwnPassword(held, (await input.databases.login(from, 'app')).password)
      logMoveEvent('source_password_restored', { side: from, via: 'held-session' })
    } catch (error) {
      logMoveEvent('source_password_session_restore_failed', {
        side: from,
        ...describeMoveError(error)
      })
      if (input.restoreSourcePassword) {
        await input.restoreSourcePassword().then(
          () => logMoveEvent('source_password_restored', { side: from, via: 'cloud-sql-admin' }),
          (fallback: unknown) =>
            logMoveEvent('source_password_not_restored', {
              side: from,
              run: 'restore-password',
              ...describeMoveError(fallback)
            })
        )
      } else {
        logMoveEvent('source_password_not_restored', { side: from, run: 'restore-password' })
      }
    }
  }
  // Also when the write's reply was lost: the object may hold our window anyway.
  if (quiesceId) {
    await clearQuiesce(input.pointerStore, quiesceId, written).catch((error: unknown) =>
      logMoveEvent('quiesce_clear_failed', describeMoveError(error))
    )
  }
}
