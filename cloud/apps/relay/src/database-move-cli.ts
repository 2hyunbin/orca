import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  MoveDatabases,
  type MoveCredentialSource,
  type MoveCredentialSources,
  type MoveRole,
  type MoveSide
} from './database-move-connections.js'
import {
  copyCommand,
  installTrackingCommand,
  prepareTargetCommand,
  syncCommand,
  uninstallTrackingCommand,
  verifyCommand
} from './database-move-commands.js'
import {
  cutoverCommand,
  fenceCommand,
  finishCommand,
  restorePasswordCommand,
  statusCommand,
  type MoveCutoverContext
} from './database-move-cutover-commands.js'
import { CUTOVER_TIMINGS } from './database-move-cutover.js'
import { describeMoveError, logMoveEvent, MoveRefusal } from './database-move-events.js'
import { gcsDatabaseTargetPointerStore } from './database-move-pointer-store.js'
import { googleMetadataAccess } from './google-metadata-access-token.js'

// node apps/relay/dist/database-move-cli.js <command> [flags]; runs as a Cloud Run job on the
// relay image. Credentials are Secret Manager version names (flags or env); a *_URL env var is
// accepted instead for local runs only. Exit 0 = done, 2 = refused (nothing unsafe happened),
// 1 = failed, 3 = copy stopped by a signal (run it again to resume).
const USAGE = `commands:
  install-tracking --side primary|dedicated     uninstall-tracking --side primary|dedicated
  prepare-target                                copy --from primary|dedicated [--restart]
  sync --from primary|dedicated [--until-empty] verify [--tables a,b]
  fence --side primary|dedicated                restore-password --side primary|dedicated
  cutover --to dedicated|primary [--dry-run]    status
  finish --keep primary|dedicated`

// Both sides together; a 13 M-row database verifies in about 11 minutes.
const DEFAULT_VERIFY_ROWS_PER_SECOND = 40_000

const OPTIONS = {
  side: { type: 'string' },
  keep: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'dry-run': { type: 'boolean' },
  restart: { type: 'boolean' },
  'until-empty': { type: 'boolean' },
  tables: { type: 'string' },
  'batch-rows': { type: 'string' },
  'batch-keys': { type: 'string' },
  'max-bytes-per-second': { type: 'string' },
  'chunk-rows': { type: 'string' },
  'max-rows-per-second': { type: 'string' },
  'max-backlog': { type: 'string' },
  'hot-table-max-rows': { type: 'string' },
  'lead-ms': { type: 'string' },
  'pointer-bucket': { type: 'string' },
  'primary-app-secret': { type: 'string' },
  'primary-move-secret': { type: 'string' },
  'dedicated-app-secret': { type: 'string' },
  'dedicated-move-secret': { type: 'string' }
} as const

type ParsedFlags = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values']

function side(value: string | undefined, flag: string): MoveSide {
  if (value === 'primary' || value === 'dedicated') return value
  throw new MoveRefusal('flag_needs_primary_or_dedicated', { flag })
}

function count(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new MoveRefusal('flag_needs_a_count', { flag })
  return parsed
}

function credentialSources(flags: ParsedFlags, env: NodeJS.ProcessEnv): MoveCredentialSources {
  const sources: MoveCredentialSources = {}
  for (const moveSide of ['primary', 'dedicated'] as const) {
    for (const role of ['app', 'move'] as const satisfies readonly MoveRole[]) {
      const flag = flags[`${moveSide}-${role}-secret`]
      const prefix = `ORCA_RELAY_MOVE_${moveSide.toUpperCase()}_${role.toUpperCase()}`
      const secret = flag ?? env[`${prefix}_SECRET`]
      const url = env[`${prefix}_URL`]
      const source: MoveCredentialSource | null = secret ? { secret } : url ? { url } : null
      if (source) sources[moveSide] = { ...sources[moveSide], [role]: source }
    }
  }
  return sources
}

export async function runMoveCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let databases: MoveDatabases | null = null
  try {
    const { values: flags, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true
    })
    const command = positionals[0]
    const google = googleMetadataAccess()
    databases = new MoveDatabases(credentialSources(flags, env), google)
    const ctx: MoveCutoverContext = {
      databases,
      google,
      pointerStore: async () =>
        gcsDatabaseTargetPointerStore({
          bucket: flags['pointer-bucket'] ?? `${await google.projectId()}-relay-control`,
          google
        })
    }
    // Only the long-running commands stop cleanly (cutover undoes); the rest keep Node's default.
    const stop = { requested: false }
    if (command === 'sync' || command === 'copy' || command === 'cutover') {
      // `on`, not `once`: a repeated signal must not kill a stop that is still cleaning up.
      process.on('SIGTERM', () => (stop.requested = true))
      process.on('SIGINT', () => (stop.requested = true))
    }
    switch (command) {
      case 'install-tracking':
        await installTrackingCommand(ctx, side(flags.side, 'side'))
        return 0
      case 'uninstall-tracking':
        await uninstallTrackingCommand(ctx, side(flags.side, 'side'))
        return 0
      case 'prepare-target':
        await prepareTargetCommand(ctx)
        return 0
      case 'copy': {
        const { stopped } = await copyCommand(ctx, side(flags.from, 'from'), {
          restart: flags.restart ?? false,
          batchRows: count(flags['batch-rows'], 'batch-rows'),
          maxBytesPerSecond: count(flags['max-bytes-per-second'], 'max-bytes-per-second'),
          maxRowsPerSecond: count(flags['max-rows-per-second'], 'max-rows-per-second'),
          shouldStop: () => stop.requested
        })
        return stopped ? 3 : 0
      }
      case 'sync':
        await syncCommand(ctx, side(flags.from, 'from'), {
          batchKeys: count(flags['batch-keys'], 'batch-keys'),
          ...(flags['until-empty'] ? { stopAtBacklog: 0 } : {}),
          shouldStop: () => stop.requested
        })
        return 0
      case 'verify':
        return (await verifyCommand(ctx, {
          tables: flags.tables?.split(','),
          chunkRows: count(flags['chunk-rows'], 'chunk-rows'),
          maxRowsPerSecond:
            count(flags['max-rows-per-second'], 'max-rows-per-second') ??
            DEFAULT_VERIFY_ROWS_PER_SECOND
        }))
          ? 0
          : 2
      case 'fence':
        await fenceCommand(ctx, side(flags.side, 'side'))
        return 0
      case 'restore-password':
        await restorePasswordCommand(ctx, side(flags.side, 'side'))
        return 0
      case 'cutover': {
        const leadMs = count(flags['lead-ms'], 'lead-ms') ?? CUTOVER_TIMINGS.leadMs
        // Two 5 s polls must see the window before it opens.
        if (leadMs < CUTOVER_TIMINGS.leadMs) throw new MoveRefusal('lead_ms_below_contract_minimum')
        await cutoverCommand(ctx, {
          to: side(flags.to, 'to'),
          dryRun: flags['dry-run'] ?? false,
          maxBacklog: count(flags['max-backlog'], 'max-backlog'),
          hotTableMaxRows: count(flags['hot-table-max-rows'], 'hot-table-max-rows'),
          timings: { leadMs },
          interrupted: () => stop.requested
        })
        return 0
      }
      case 'finish':
        await finishCommand(ctx, side(flags.keep, 'keep'))
        return 0
      case 'status':
        await statusCommand(ctx)
        return 0
      default:
        console.error(USAGE)
        return 2
    }
  } catch (error) {
    logMoveEvent('command_failed', describeMoveError(error))
    return error instanceof MoveRefusal ? 2 : 1
  } finally {
    databases?.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMoveCli(process.argv.slice(2))
}
