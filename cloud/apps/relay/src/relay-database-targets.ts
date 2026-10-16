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

export type RelayDatabaseTarget = {
  // The authority generation, or null for any failure: refused, unreachable, or too slow.
  probe(timeoutMs: number): Promise<{ generation: number; opened: OpenedRelayDatabaseTarget } | null>
  close(): Promise<void>
}

// The move tool owns this table on both targets; the relay only reads it.
const AUTHORITY_SQL = 'SELECT generation FROM relay_database_authority'
const UNDEFINED_TABLE = '42P01'

// A failed or slow probe destroys its client, so a refused or stuck session never returns to
// the pool.
export async function readRelayDatabaseAuthorityGeneration(
  pool: pg.Pool,
  timeoutMs: number
): Promise<number | null> {
  let client: pg.PoolClient | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let released = false
  const release = (destroy: boolean): void => {
    if (released || !client) return
    released = true
    client.release(destroy)
  }
  try {
    client = await pool.connect()
    const connected = client
    timer = setTimeout(() => release(true), timeoutMs)
    timer.unref?.()
    const result = await connected.query(AUTHORITY_SQL)
    release(false)
    const generation = Number(result.rows[0]?.generation ?? 0)
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : null
  } catch (error) {
    const undefinedTable =
      typeof error === 'object' && error !== null && 'code' in error && error.code === UNDEFINED_TABLE
    release(!undefinedTable)
    return undefinedTable ? 0 : null
  } finally {
    clearTimeout(timer)
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
  const { opened, pool } = openedPostgresTarget({ connectionString: databaseUrl }, settings)
  return {
    opened,
    probe: async (timeoutMs) => {
      const generation = await readRelayDatabaseAuthorityGeneration(pool, timeoutMs)
      return generation === null ? null : { generation, opened }
    },
    close: async () => await opened.database.close()
  }
}

// Opens on the first probe, and again on a later one after a failure: the secret read and the
// connector's instance lookup are the only steps that can fail before a session exists.
export function openDedicatedRelayDatabaseTarget(
  target: DedicatedDatabaseTarget,
  settings: RelayPostgresPoolSettings,
  google: GoogleMetadataAccess
): RelayDatabaseTarget {
  let opening: Promise<{ opened: OpenedRelayDatabaseTarget; pool: pg.Pool }> | null = null
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

  const open = async (): Promise<{ opened: OpenedRelayDatabaseTarget; pool: pg.Pool }> => {
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

  return {
    probe: async (timeoutMs) => {
      opening ??= open()
      const current = opening
      const ready = await current.catch((error: unknown) => {
        if (opening === current) opening = null
        reportOpenFailure(error)
        return null
      })
      if (!ready) return null
      const generation = await readRelayDatabaseAuthorityGeneration(ready.pool, timeoutMs)
      return generation === null ? null : { generation, opened: ready.opened }
    },
    close: async () => {
      closed = true
      const current = opening
      opening = null
      const ready = await current?.catch(() => null)
      await ready?.opened.database.close().catch(() => undefined)
      connector?.close()
    }
  }
}
