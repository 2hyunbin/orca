import { parse as parseConnectionString } from 'pg-connection-string'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'

const SECRET_MANAGER_ROOT = 'https://secretmanager.googleapis.com/v1'
const SECRET_READ_TIMEOUT_MS = 3_000
const MAX_SECRET_BYTES = 16 * 1024

export type DedicatedDatabaseCredentials = { user: string; password: string; database: string }

// Messages name the step only: the secret's value, or any part of it, never reaches a log.
export class DedicatedDatabaseSecretError extends Error {
  constructor(readonly step: 'read' | 'payload' | 'parse') {
    super(`dedicated_database_secret_${step}`)
  }
}

// Only user, password and database are used: the instance comes from the pointer, and the
// connector replaces the URL's socket host.
export async function readDedicatedDatabaseCredentials(
  secretVersion: string,
  google: GoogleMetadataAccess,
  fetchImpl: typeof fetch = fetch
): Promise<DedicatedDatabaseCredentials> {
  return parseDedicatedDatabaseUrl(await readSecretManagerText(secretVersion, google, fetchImpl))
}

export async function readSecretManagerText(
  secretVersion: string,
  google: GoogleMetadataAccess,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(`${SECRET_MANAGER_ROOT}/${secretVersion}:access`, {
    headers: { authorization: `Bearer ${await google.accessToken()}` },
    signal: AbortSignal.timeout(SECRET_READ_TIMEOUT_MS)
  }).catch(() => {
    throw new DedicatedDatabaseSecretError('read')
  })
  if (response.status === 401) google.forgetAccessToken()
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new DedicatedDatabaseSecretError('read')
  }
  const body: unknown = await response.json().catch(() => null)
  const encoded =
    typeof body === 'object' &&
    body !== null &&
    'payload' in body &&
    typeof body.payload === 'object' &&
    body.payload !== null &&
    'data' in body.payload &&
    typeof body.payload.data === 'string'
      ? body.payload.data
      : null
  if (encoded === null || encoded.length > MAX_SECRET_BYTES * 2) {
    throw new DedicatedDatabaseSecretError('payload')
  }
  return Buffer.from(encoded, 'base64').toString('utf8').trim()
}

export function parseDedicatedDatabaseUrl(databaseUrl: string): DedicatedDatabaseCredentials {
  let parsed: ReturnType<typeof parseConnectionString>
  try {
    parsed = parseConnectionString(databaseUrl)
  } catch {
    throw new DedicatedDatabaseSecretError('parse')
  }
  const { user, password, database } = parsed
  if (!user || !password || !database) throw new DedicatedDatabaseSecretError('parse')
  return { user, password, database }
}
