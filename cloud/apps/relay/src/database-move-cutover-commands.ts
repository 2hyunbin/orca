import { restorePasswordWithCloudSqlAdmin } from './database-move-cloud-sql-password.js'
import { readMoveTables } from './database-move-catalog.js'
import { withClients, type MoveCommandContext } from './database-move-commands.js'
import { otherMoveSide, type MoveSide } from './database-move-connections.js'
import {
  readUnmarkedRelaySessions,
  runCutover,
  type CutoverInput
} from './database-move-cutover.js'
import { describeMoveError, logMoveEvent, MoveRefusal } from './database-move-events.js'
import { fenceWithSession } from './database-move-fence.js'
import type { DatabaseTargetPointerStore } from './database-move-pointer-store.js'
import {
  MOVE_CLAIMED_TABLE,
  MOVE_COPY_PROGRESS_TABLE,
  readAuthorityGeneration,
  readDirtyBacklog,
  readTrackingState
} from './database-move-tracking.js'

// The commands that touch the relay role's password or the pointer the processes follow.
export type MoveCutoverContext = MoveCommandContext & {
  pointerStore: () => Promise<DatabaseTargetPointerStore>
}

export async function fenceCommand(ctx: MoveCutoverContext, side: MoveSide): Promise<void> {
  await withClients([ctx.databases.connect(side, 'app', 'fence')], async ([app]) => {
    if (!app) throw new MoveRefusal('session_missing')
    const result = await fenceWithSession(app)
    logMoveEvent('fence_done', { side, ...result, restoreWith: 'restore-password' })
  })
}

// Reopening a side the pointer says is behind would let a stale writer onto old rows. The
// cutover's own abort and rollback restores go through restoreSidePassword directly.
export async function restorePasswordCommand(
  ctx: MoveCutoverContext,
  side: MoveSide
): Promise<void> {
  const stored = await (await ctx.pointerStore()).read()
  const pointerGeneration = stored?.pointer.generation
  if (pointerGeneration !== undefined) {
    const sideGeneration = await withClients(
      [ctx.databases.connect(side, 'move', 'restore-check')],
      async ([client]) => {
        if (!client) throw new MoveRefusal('session_missing')
        return await readAuthorityGeneration(client)
      }
    )
    if (sideGeneration < pointerGeneration) {
      throw new MoveRefusal('side_is_behind_the_pointer', {
        side,
        sideGeneration,
        pointerGeneration,
        run: `cutover --to ${side}`
      })
    }
  }
  await restoreSidePassword(ctx, side)
}

async function restoreSidePassword(ctx: MoveCutoverContext, side: MoveSide): Promise<void> {
  const login = await ctx.databases.login(side, 'app')
  if (!login.instanceConnectionName) throw new MoveRefusal('not_a_cloud_sql_url', { side })
  if (!ctx.google) throw new MoveRefusal('google_access_unavailable')
  const { operation } = await restorePasswordWithCloudSqlAdmin({
    instanceConnectionName: login.instanceConnectionName,
    user: login.user,
    password: login.password,
    google: ctx.google
  })
  logMoveEvent('password_restored', { side, operation })
}

export async function cutoverCommand(
  ctx: MoveCutoverContext,
  input: Omit<
    CutoverInput,
    'databases' | 'pointerStore' | 'restoreSourcePassword' | 'restoreTargetPassword'
  >
): Promise<void> {
  const from = otherMoveSide(input.to)
  await runCutover({
    ...input,
    databases: ctx.databases,
    pointerStore: await ctx.pointerStore(),
    ...(ctx.google
      ? {
          restoreSourcePassword: async () => await restoreSidePassword(ctx, from),
          restoreTargetPassword: async () => await restoreSidePassword(ctx, input.to)
        }
      : {})
  })
}

async function sideStatus(
  ctx: MoveCutoverContext,
  side: MoveSide
): Promise<Record<string, unknown>> {
  if (!ctx.databases.has(side, 'move')) return { configured: false }
  return await withClients([ctx.databases.connect(side, 'move', 'status')], async ([client]) => {
    if (!client) throw new MoveRefusal('session_missing')
    const tables = await readMoveTables(client)
    const tracking = await readTrackingState(client, tables)
    // null before prepare-target or install-tracking created the table.
    const count = async (sql: string): Promise<number | null> => {
      const result = await client.query(sql).catch(() => null)
      return result ? Number(result.rows[0]?.n ?? 0) : null
    }
    const status: Record<string, unknown> = {
      generation: await readAuthorityGeneration(client),
      tracking: {
        dirtyTable: tracking.dirtyTable,
        sentinel: tracking.sentinel,
        untracked: tracking.untracked
      },
      backlog: tracking.dirtyTable ? await readDirtyBacklog(client) : null,
      claimed: tracking.dirtyTable
        ? await count(`SELECT count(*)::int AS n FROM ${MOVE_CLAIMED_TABLE}`)
        : null,
      copiedTables: await count(
        `SELECT count(*)::int AS n FROM ${MOVE_COPY_PROGRESS_TABLE} WHERE done`
      ),
      tables: tables.length
    }
    if (ctx.databases.has(side, 'app')) {
      const appUser = (await ctx.databases.login(side, 'app')).user
      const sessions = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE usename = $1 AND coalesce(backend_type, 'client backend') = 'client backend'`,
        [appUser]
      )
      status.relaySessions = Number(sessions.rows[0]?.n ?? 0)
      status.relaySessionsWithoutMoveCapability = await readUnmarkedRelaySessions(client, appUser)
    }
    return status
  })
}

export async function statusCommand(ctx: MoveCutoverContext): Promise<void> {
  const report = async (run: () => Promise<unknown>): Promise<unknown> =>
    await run().catch((error: unknown) => ({ unavailable: describeMoveError(error) }))
  const [primary, dedicated, pointer] = await Promise.all([
    report(() => sideStatus(ctx, 'primary')),
    report(() => sideStatus(ctx, 'dedicated')),
    report(async () => {
      const stored = await (await ctx.pointerStore()).read()
      return stored
        ? { present: true, ...stored.pointer, generation: stored.generation }
        : { present: false }
    })
  ])
  logMoveEvent('status', { primary, dedicated, pointer })
}
