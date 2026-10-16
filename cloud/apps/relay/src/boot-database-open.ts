import { randomBytes } from 'node:crypto'
import {
  markRelayDatabaseMoveCapability,
  openRelayDatabase,
  type RelayDatabase,
  type RelayDatabaseOpenInput
} from './database.js'
import { googleMetadataAccess } from './google-metadata-access-token.js'
import { startControlFlagChannel, type ControlFlagChannel } from './relay-control-flag-channel.js'
import {
  DATABASE_TARGET_POINTER_APPLIED_EVENT,
  DATABASE_TARGET_POINTER_OBJECT,
  parseDatabaseTargetPointer,
  type DatabaseTargetPointer
} from './relay-database-target-pointer.js'
import {
  openDedicatedRelayDatabaseTarget,
  openPrimaryRelayDatabaseTarget
} from './relay-database-targets.js'
import {
  RelayDatabaseTargetUnavailableError,
  SwitchingRelayDatabase
} from './switching-relay-database.js'
import { retryTransientDatabaseStartup } from './database-startup-retry.js'
import {
  isPostgresPoolConnectFailure,
  isPostgresPoolConnectTimeout
} from './postgres-pool-pressure.js'
import { postgresErrorCodeCategory } from './postgres-query-failure.js'

// Only a failure to reach Postgres at all. A retry here re-runs the schema
// apply, and applyPostgresSchema refuses to repeat a DDL lock timeout on
// purpose: relation locks are granted in queue order, so a repeat parks every
// writer behind the same statement again. 55P03, 57014 and 53300 therefore stay
// terminal at boot even though the request path calls them transient.
function isBootDatabaseUnreachable(error: unknown): boolean {
  const code = postgresErrorCodeCategory(error)
  return (
    isPostgresPoolConnectFailure(error) ||
    code === '08001' ||
    code === '08006' ||
    // No target may serve yet (no pointer read during a move); the switcher keeps probing.
    error instanceof RelayDatabaseTargetUnavailableError
  )
}

// A cell boots beside a cloud-sql-proxy that is itself still dialling, so the
// first pool acquire can outrun the 2s connect timeout that protects the
// request path. The window is longer than a proxy cold start and shorter than
// the restart loop it replaces.
const BOOT_OPEN_RETRY = {
  attempts: 20,
  windowMs: 45_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitterMs: 250,
  isRetryable: isBootDatabaseUnreachable
}

function bootDatabaseErrorFields(error: unknown): Record<string, unknown> {
  return {
    code: postgresErrorCodeCategory(error),
    connectionTimeout: isPostgresPoolConnectTimeout(error)
  }
}

export async function openRelayDatabaseAtBoot(
  input: RelayDatabaseOpenInput,
  open: (input: RelayDatabaseOpenInput) => Promise<RelayDatabase> = openRelayDatabase
): Promise<RelayDatabase> {
  return await retryBootDatabaseStep(async () => await open(input))
}

async function retryBootDatabaseStep<T>(step: () => Promise<T>): Promise<T> {
  return await retryTransientDatabaseStartup(
    step,
    BOOT_OPEN_RETRY,
    {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          JSON.stringify({
            event: 'orca_relay_boot_database_retry',
            attempt,
            delayMs,
            ...bootDatabaseErrorFields(error)
          })
        ),
      onRecovered: ({ attempts }) =>
        console.warn(
          JSON.stringify({ event: 'orca_relay_boot_database_recovered', attempts })
        ),
      onGaveUp: ({ attempts, error, retryable }) =>
        console.warn(
          JSON.stringify({
            event: 'orca_relay_boot_database_failed',
            attempts,
            retryable,
            ...bootDatabaseErrorFields(error)
          })
        )
    }
  )
}

// Directors and cells on GCP follow the database-target pointer; with no pointer they serve
// DATABASE_URL exactly as openRelayDatabaseAtBoot does. Opening touches no database: the target
// is chosen at the first operation, or before the director's schema, whichever comes first.
export async function openSwitchingRelayDatabaseAtBoot(
  input: RelayDatabaseOpenInput & { databaseUrl: string }
): Promise<{ database: SwitchingRelayDatabase; stop: () => void }> {
  const settings = {
    ...input,
    // One id per process, on both targets' sessions alike.
    applicationName: markRelayDatabaseMoveCapability(
      input.applicationName ?? 'orca-relay',
      randomBytes(4).toString('hex')
    )
  }
  const google = googleMetadataAccess()
  let pointerChannel: ControlFlagChannel<DatabaseTargetPointer | null> | null = null
  const database = new SwitchingRelayDatabase({
    primary: openPrimaryRelayDatabaseTarget(input.databaseUrl, settings),
    openDedicated: (target) => openDedicatedRelayDatabaseTarget(target, settings, google),
    firstPointer: async () => {
      await pointerChannel?.poll()
      return pointerChannel?.applied().flags ?? null
    }
  })
  pointerChannel = startControlFlagChannel<DatabaseTargetPointer | null>({
    objectName: DATABASE_TARGET_POINTER_OBJECT,
    defaults: null,
    parse: parseDatabaseTargetPointer,
    appliedEvent: DATABASE_TARGET_POINTER_APPLIED_EVENT,
    google,
    onApplied: (applied) => database.applyPointer(applied.flags)
  })
  const channel = pointerChannel
  if (input.appliesPostgresSchema !== false) {
    try {
      await retryBootDatabaseStep(async () => await database.applySchemaToActiveTarget())
    } catch (error) {
      channel.stop()
      await database.close().catch(() => undefined)
      throw error
    }
  }
  return { database, stop: () => channel.stop() }
}
