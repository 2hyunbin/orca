import { randomUUID } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import pg from 'pg'
import type { ConnectorConfig } from './config.js'
import { openConnectorDatabase, openInMemoryConnectorDatabase } from './connector-database.js'
import { createConnectorServer } from './connector-server.js'

export const PUBLIC_URL = 'https://connector.onorca.dev'
export const AUTH_ISSUER = 'https://login.onorca.dev'

// Real Postgres when the CI service is present; each harness gets its own schema.
const testDatabaseUrl = process.env.ORCA_CONNECTOR_TEST_DATABASE_URL

export function testConnectorConfig(): ConnectorConfig {
  return {
    mode: 'active',
    port: 0,
    publicUrl: PUBLIC_URL,
    dataDir: './data/connector-test',
    databasePoolMax: 4,
    authIssuer: AUTH_ISSUER,
    jwksUrl: `${AUTH_ISSUER}/.well-known/jwks.json`,
    trustedProxyHops: 0
  }
}

const cleanups: (() => Promise<void>)[] = []
export async function cleanupConnectorHarnesses(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
}

async function openTestDatabase(): Promise<CloudDatabase> {
  if (!testDatabaseUrl) {
    const database = await openInMemoryConnectorDatabase()
    cleanups.push(() => database.close())
    return database
  }
  const admin = new pg.Client({ connectionString: testDatabaseUrl })
  await admin.connect()
  const schema = `connector_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const url = new URL(testDatabaseUrl)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const database = await openConnectorDatabase({ databaseUrl: url.toString(), dataDir: '', poolMax: 4 })
  cleanups.push(async () => {
    await database.close()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })
  return database
}

export async function createConnectorHarness(config: Partial<ConnectorConfig> = {}) {
  const database = await openTestDatabase()
  const runtime = createConnectorServer({ ...testConnectorConfig(), ...config }, database)
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(runtime.app.request(path, init))
  return { runtime, database, request }
}
