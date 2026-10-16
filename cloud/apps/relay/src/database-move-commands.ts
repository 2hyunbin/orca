import type pg from 'pg'
import { applyRelayPostgresSchema, openRelayPostgresPool } from './database.js'
import { compareMoveSchemas, readMoveTables, type MoveTable } from './database-move-catalog.js'
import {
  endQuietly,
  moveApplicationName,
  otherMoveSide,
  type MoveDatabases,
  type MoveSide
} from './database-move-connections.js'
import { runCopy, type MoveCopyOptions } from './database-move-copy.js'
import { logMoveEvent, MoveRefusal } from './database-move-events.js'
import {
  replayClaims,
  requireCurrentCopy,
  requireTracking,
  runSyncLoop,
  takeSyncLock,
  type MoveSyncOptions,
  type MoveSyncSessions
} from './database-move-sync.js'
import {
  createMoveBookkeeping,
  grantMoveRole,
  installTracking,
  readAuthorityGeneration,
  uninstallTracking
} from './database-move-tracking.js'
import { verifyMoveTables, verdictsEqual, type MoveVerifyOptions } from './database-move-verify.js'
import type { DatabaseTargetPointerStore } from './database-move-pointer-store.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'

export type MoveCommandContext = {
  databases: MoveDatabases
  google: GoogleMetadataAccess | null
  pointerStore: () => Promise<DatabaseTargetPointerStore>
}

export async function withClients<T>(
  open: Array<Promise<pg.Client>>,
  run: (clients: pg.Client[]) => Promise<T>
): Promise<T> {
  const settled = await Promise.allSettled(open)
  const clients = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  try {
    const failed = settled.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    return await run(clients)
  } finally {
    await Promise.all(clients.map((client) => endQuietly(client)))
  }
}

function pair(clients: pg.Client[]): [pg.Client, pg.Client] {
  const [first, second] = clients
  if (!first || !second) throw new MoveRefusal('session_missing')
  return [first, second]
}

// Processes serve the side with the higher authority generation (a tie is primary's); copy and
// sync must never write into it.
async function refuseWritingTheActiveSide(
  sessions: MoveSyncSessions,
  from: MoveSide
): Promise<void> {
  const [source, target] = await Promise.all([
    readAuthorityGeneration(sessions.source),
    readAuthorityGeneration(sessions.target)
  ])
  const dedicatedActive = from === 'dedicated' ? source > target : target > source
  if ((from === 'primary') === dedicatedActive) {
    throw new MoveRefusal('target_is_the_active_side', { from })
  }
}

// Both sides as the tool role, after proving their tables agree.
async function withMoveSessions<T>(
  ctx: MoveCommandContext,
  from: MoveSide,
  purpose: string,
  run: (sessions: MoveSyncSessions, tables: MoveTable[]) => Promise<T>
): Promise<T> {
  const to = otherMoveSide(from)
  return await withClients(
    [ctx.databases.connect(from, 'move', purpose), ctx.databases.connect(to, 'move', purpose)],
    async (clients) => {
      const [source, target] = pair(clients)
      const tables = await readMoveTables(source)
      const targetTables = await readMoveTables(target)
      const primary =
        from === 'primary' ? { client: source, tables } : { client: target, tables: targetTables }
      const dedicated =
        from === 'primary' ? { client: target, tables: targetTables } : { client: source, tables }
      await compareMoveSchemas(primary, dedicated)
      return await run({ source, target }, tables)
    }
  )
}

export async function installTrackingCommand(
  ctx: MoveCommandContext,
  side: MoveSide
): Promise<void> {
  const toolUser = (await ctx.databases.login(side, 'move')).user
  await withClients([ctx.databases.connect(side, 'app', 'install-tracking')], async ([app]) => {
    if (!app) throw new MoveRefusal('session_missing')
    const tables = await readMoveTables(app)
    const { sentinel } = await installTracking(app, { toolUser, tables })
    logMoveEvent('install_tracking_done', { side, tables: tables.length, sentinel })
    if (sentinel === 'missing') logMoveEvent('sentinel_missing', { side, run: 'copy --restart' })
  })
}

export async function uninstallTrackingCommand(
  ctx: MoveCommandContext,
  side: MoveSide
): Promise<void> {
  // A side a cutover left is fenced: the relay role cannot log in there any more, and
  // restore-password refuses it. Its triggers go with the database.
  const connecting = ctx.databases
    .connect(side, 'app', 'uninstall-tracking')
    .catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '28P01'
      ) {
        throw new MoveRefusal('side_is_fenced', {
          side,
          run: 'once the move is finished, drop the old database through the Cloud SQL API (gcloud sql databases delete), which needs no login'
        })
      }
      throw error
    })
  await withClients([connecting], async ([app]) => {
    if (!app) throw new MoveRefusal('session_missing')
    const tables = await readMoveTables(app)
    await uninstallTracking(app, tables)
    logMoveEvent('uninstall_tracking_done', { side, tables: tables.length })
  })
}

// The dedicated side gets the relay schema exactly as a director applies it; both sides get the
// authority and progress tables and the tool role's grants; then the two schemas must agree.
// Creating the authority table on primary starts the period in which a process serves only after
// reading the pointer, so the pointer must already be there and readable (`finish` ends it).
export async function prepareTargetCommand(ctx: MoveCommandContext): Promise<void> {
  const stored = await (await ctx.pointerStore()).read()
  if (!stored) throw new MoveRefusal('pointer_absent', { run: 'write database-target.json first' })
  const connection = await ctx.databases.connection('dedicated', 'app')
  const applicationName = moveApplicationName('prepare-target')
  const { database } = openRelayPostgresPool(connection, { applicationName, poolMax: 1 })
  try {
    await applyRelayPostgresSchema(connection, applicationName, database)
  } finally {
    await database.close().catch(() => undefined)
  }
  logMoveEvent('schema_applied', { side: 'dedicated' })
  const sides = ['primary', 'dedicated'] as const
  const toolUsers = await Promise.all(
    sides.map(async (side) => (await ctx.databases.login(side, 'move')).user)
  )
  await withClients(
    sides.map((side) => ctx.databases.connect(side, 'app', 'prepare-target')),
    async (clients) => {
      const [primary, dedicated] = pair(clients)
      const tables: MoveTable[][] = []
      for (const [index, client] of [primary, dedicated].entries()) {
        const sideTables = await readMoveTables(client)
        await createMoveBookkeeping(client)
        await grantMoveRole(client, toolUsers[index] ?? '', sideTables)
        tables.push(sideTables)
      }
      await compareMoveSchemas(
        { client: primary, tables: tables[0] ?? [] },
        { client: dedicated, tables: tables[1] ?? [] }
      )
      logMoveEvent('prepare_target_done', { tables: tables[0]?.length ?? 0 })
    }
  )
}

export async function copyCommand(
  ctx: MoveCommandContext,
  from: MoveSide,
  options: MoveCopyOptions
): Promise<{ stopped: boolean }> {
  return await withMoveSessions(ctx, from, 'copy', async (sessions, tables) => {
    // Lock first: a cutover holding it may still move which side is active.
    await takeSyncLock(sessions.source)
    await refuseWritingTheActiveSide(sessions, from)
    return await runCopy(sessions, tables, options)
  })
}

export async function syncCommand(
  ctx: MoveCommandContext,
  from: MoveSide,
  options: MoveSyncOptions
): Promise<void> {
  await withMoveSessions(ctx, from, 'sync', async (sessions, tables) => {
    await takeSyncLock(sessions.source)
    await refuseWritingTheActiveSide(sessions, from)
    await requireTracking(sessions.source, tables)
    await requireCurrentCopy(sessions, tables, 'apply')
    const replayed = await replayClaims(sessions, tables)
    logMoveEvent('sync_started', { from, replayed })
    const result = await runSyncLoop(sessions, tables, { ...options, label: { from } })
    logMoveEvent('sync_stopped', { from, ...result })
  })
}

export async function verifyCommand(
  ctx: MoveCommandContext,
  options: MoveVerifyOptions & { tables?: string[] }
): Promise<boolean> {
  return await withMoveSessions(ctx, 'primary', 'verify', async (sessions, tables) => {
    const selected = options.tables
      ? tables.filter((table) => options.tables?.includes(table.name))
      : tables
    const verdicts = await verifyMoveTables(sessions.source, sessions.target, selected, options)
    const equal = verdictsEqual(verdicts)
    logMoveEvent('verify_done', {
      equal,
      tables: selected.length,
      differing: verdicts
        .filter((verdict) => verdict.mismatches.length > 0)
        .map((verdict) => verdict.table)
    })
    return equal
  })
}
