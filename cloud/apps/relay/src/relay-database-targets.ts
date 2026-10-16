import { AuthTypes, Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import type pg from 'pg'
import {
  applyRelayPostgresSchema,
  openRelayPostgresPool,
  type RelayDatabase,
  type RelayPostgresConnection,
  type RelayPostgresPoolSettings
} from './database.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'
import type { DedicatedDatabaseTarget } from './relay-database-target-pointer.js'
import {
  DedicatedDatabaseSecretError,
  readDedicatedDatabaseCredentials
} from './relay-dedicated-database-secret.js'

export type RelayDatabaseTargetName = 'primary' | 'dedicated'

export type OpenedRelayDatabaseTarget = {
  database: RelayDatabase
  applySchema(): Promise<void>
}

// `superseded`: the move tool marked this copy as left behind; it is never eligible.
export type RelayDatabaseProbeResult = {
  generation: number
  superseded: boolean
  opened: OpenedRelayDatabaseTarget
}

// Probes on one held session: while it is open, the target sees this process's marked
// application_name, which is how the move tool knows the process can reach it.
export type RelayDatabaseProbeSession = {
  // The authority generation, or null for any failure: refused, unreachable, or too slow.
  probe(timeoutMs: number): Promise<RelayDatabaseProbeResult | null>
  close(): void
}

export type RelayDatabaseTarget = {
  probe(timeoutMs: number): Promise<RelayDatabaseProbeResult | null>
  probeSession(): RelayDatabaseProbeSession
  close(): Promise<void>
}

// The move tool owns this table on both targets; the relay only reads it. The whole row as JSON,
// so a table from before the `superseded` column reads as not superseded in the same one query.
const AUTHORITY_SQL = 'SELECT to_jsonb(authority) AS row FROM relay_database_authority authority'
const UNDEFINED_TABLE = '42P01'

type ReadyTarget = { pool: pg.Pool; opened: OpenedRelayDatabaseTarget }

// No row is generation 0, not superseded; a malformed row is no answer.
function authorityRow(
  row: unknown,
  opened: OpenedRelayDatabaseTarget
): RelayDatabaseProbeResult | null {
  if (row === undefined) return { generation: 0, superseded: false, opened }
  if (typeof row !== 'object' || row === null || !('generation' in row)) return null
  const generation = Number(row.generation)
  if (!Number.isSafeInteger(generation) || generation < 0) return null
  const superseded = 'superseded' in row && row.superseded === true
  return { generation, superseded, opened }
}

// A failed or slow probe destroys its client, so a refused or stuck session never returns to
// the pool; a good one keeps it for the next probe until close().
function postgresProbeSession(ready: () => Promise<ReadyTarget | null>): RelayDatabaseProbeSession {
  let client: pg.PoolClient | null = null
  let closed = false
  const drop = (held: pg.PoolClient, destroy: boolean): void => {
    if (client === held) client = null
    held.release(destroy)
  }
  return {
    probe: async (timeoutMs) => {
      const target = await ready()
      if (!target || closed) return null
      let held: pg.PoolClient | null = client
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!held) {
          held = await target.pool.connect()
          if (closed) {
            held.release()
            return null
          }
          client = held
        }
        const querying = held
        timer = setTimeout(() => drop(querying, true), timeoutMs)
        timer.unref?.()
        const result = await querying.query(AUTHORITY_SQL)
        return authorityRow(result.rows[0]?.row, target.opened)
      } catch (error) {
        const undefinedTable =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === UNDEFINED_TABLE
        if (held && client === held && !undefinedTable) drop(held, true)
        return undefinedTable && held
          ? { generation: 0, superseded: false, opened: target.opened }
          : null
      } finally {
        clearTimeout(timer)
      }
    },
    close: () => {
      closed = true
      if (client) drop(client, false)
    }
  }
}

function postgresTarget(
  ready: () => Promise<ReadyTarget | null>,
  close: () => Promise<void>
): RelayDatabaseTarget {
  return {
    probe: async (timeoutMs) => {
      const session = postgresProbeSession(ready)
      try {
        return await session.probe(timeoutMs)
      } finally {
        session.close()
      }
    },
    probeSession: () => postgresProbeSession(ready),
    close
  }
}

function openedPostgresTarget(
  connection: RelayPostgresConnection,
  settings: RelayPostgresPoolSettings
): { opened: OpenedRelayDatabaseTarget; pool: pg.Pool } {
  const { database, pool } = openRelayPostgresPool(connection, settings)
  return {
    pool,
    opened: {
      database,
      applySchema: async () =>
        await applyRelayPostgresSchema(connection, settings.applicationName, database)
    }
  }
}

export function openPrimaryRelayDatabaseTarget(
  databaseUrl: string,
  settings: RelayPostgresPoolSettings
): RelayDatabaseTarget & { opened: OpenedRelayDatabaseTarget } {
  const ready = openedPostgresTarget({ connectionString: databaseUrl }, settings)
  return {
    opened: ready.opened,
    ...postgresTarget(
      async () => ready,
      async () => await ready.opened.database.close()
    )
  }
}

// Opens on the first probe, and again on a later one after a failure: the secret read and the
// connector's instance lookup are the only steps that can fail before a session exists.
export function openDedicatedRelayDatabaseTarget(
  target: DedicatedDatabaseTarget,
  settings: RelayPostgresPoolSettings,
  google: GoogleMetadataAccess
): RelayDatabaseTarget {
  let opening: Promise<ReadyTarget> | null = null
  let connector: Connector | null = null
  let closed = false
  let lastFailure: string | null = null
  // One line per change of cause; the secret error names its step, nothing else is echoed.
  const reportOpenFailure = (error: unknown): void => {
    const failure = error instanceof DedicatedDatabaseSecretError ? `secret_${error.step}` : 'connector'
    if (failure === lastFailure) return
    lastFailure = failure
    console.warn(JSON.stringify({ event: 'orca_relay_database_dedicated_unavailable', failure }))
  }

  const open = async (): Promise<ReadyTarget> => {
    const credentials = await readDedicatedDatabaseCredentials(target.databaseUrlSecret, google)
    connector ??= new Connector()
    const { stream } = await connector.getOptions({
      instanceConnectionName: target.instanceConnectionName,
      authType: AuthTypes.PASSWORD,
      ipType: IpAddressTypes.PUBLIC
    })
    if (closed) throw new Error('dedicated_database_target_closed')
    lastFailure = null
    return openedPostgresTarget({ ...credentials, stream }, settings)
  }

  const ready = async (): Promise<ReadyTarget | null> => {
    opening ??= open()
    const current = opening
    return await current.catch((error: unknown) => {
      if (opening === current) opening = null
      reportOpenFailure(error)
      return null
    })
  }
  return postgresTarget(ready, async () => {
    closed = true
    const current = opening
    opening = null
    const opened = await current?.catch(() => null)
    await opened?.opened.database.close().catch(() => undefined)
    connector?.close()
  })
}
