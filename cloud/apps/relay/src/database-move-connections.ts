import { randomBytes } from 'node:crypto'
import { AuthTypes, Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import pg from 'pg'
import { parse as parseConnectionString } from 'pg-connection-string'
import { markRelayDatabaseMoveCapability, type RelayPostgresConnection } from './database.js'
import { MoveRefusal } from './database-move-events.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'
import { readSecretManagerText } from './relay-dedicated-database-secret.js'

export type MoveSide = 'primary' | 'dedicated'
// app = the relay's own role (owns the tables); move = the tool's role, which the triggers ignore.
export type MoveRole = 'app' | 'move'
// A Secret Manager version name in production; a URL only for local runs and tests.
export type MoveCredentialSource = { secret: string } | { url: string }
export type MoveCredentialSources = Partial<
  Record<MoveSide, Partial<Record<MoveRole, MoveCredentialSource>>>
>

export type MoveLogin = {
  user: string
  password: string
  database: string
  // From a `host=/cloudsql/<connection>` URL; null for a plain host (local runs).
  instanceConnectionName: string | null
}

const CLOUD_SQL_SOCKET_PREFIX = '/cloudsql/'
const TOOL_STATEMENT_TIMEOUT_MS = 60_000

// One id per tool run, in the relay's own mark format; the cutover's gate leaves the tool's
// sessions out by their prefix.
const TOOL_PROCESS_ID = randomBytes(4).toString('hex')

export function moveApplicationName(purpose: string): string {
  return markRelayDatabaseMoveCapability(`orca-relay-move/${purpose}`, TOOL_PROCESS_ID)
}

export function otherMoveSide(side: MoveSide): MoveSide {
  return side === 'primary' ? 'dedicated' : 'primary'
}

export function parseMoveLogin(databaseUrl: string): MoveLogin {
  let parsed: ReturnType<typeof parseConnectionString>
  try {
    parsed = parseConnectionString(databaseUrl)
  } catch {
    throw new MoveRefusal('database_url_unparseable')
  }
  const { user, password, database, host } = parsed
  if (!user || !password || !database) throw new MoveRefusal('database_url_incomplete')
  const instanceConnectionName = host?.startsWith(CLOUD_SQL_SOCKET_PREFIX)
    ? host.slice(CLOUD_SQL_SOCKET_PREFIX.length)
    : null
  return { user, password, database, instanceConnectionName }
}

// Resolves each credential once, on first use, and opens one session per call. Cloud SQL URLs go
// through the in-process connector (cloudsql.client), so the job needs no proxy sidecar.
export class MoveDatabases {
  private readonly urls = new Map<string, Promise<string>>()
  private connector: Connector | null = null

  constructor(
    private readonly sources: MoveCredentialSources,
    private readonly google: GoogleMetadataAccess | null
  ) {}

  has(side: MoveSide, role: MoveRole): boolean {
    return this.sources[side]?.[role] !== undefined
  }

  async login(side: MoveSide, role: MoveRole): Promise<MoveLogin> {
    return parseMoveLogin(await this.url(side, role))
  }

  // Where a session for this side and role goes, in the shape the relay's own pools take.
  async connection(side: MoveSide, role: MoveRole): Promise<RelayPostgresConnection> {
    const url = await this.url(side, role)
    const login = parseMoveLogin(url)
    if (!login.instanceConnectionName) return { connectionString: url }
    this.connector ??= new Connector()
    const { stream } = await this.connector.getOptions({
      instanceConnectionName: login.instanceConnectionName,
      authType: AuthTypes.PASSWORD,
      ipType: IpAddressTypes.PUBLIC
    })
    return { stream, user: login.user, password: login.password, database: login.database }
  }

  // application_name carries the capability mark, so the tool's own app-role sessions never count
  // as an unmarked relay client.
  async connect(side: MoveSide, role: MoveRole, purpose: string): Promise<pg.Client> {
    const client = new pg.Client({
      ...(await this.connection(side, role)),
      application_name: moveApplicationName(purpose),
      statement_timeout: TOOL_STATEMENT_TIMEOUT_MS
    })
    // A terminated session errors on the idle client; the next query reports it instead.
    client.on('error', () => undefined)
    await client.connect()
    return client
  }

  close(): void {
    this.connector?.close()
    this.connector = null
  }

  private url(side: MoveSide, role: MoveRole): Promise<string> {
    const key = `${side}/${role}`
    let url = this.urls.get(key)
    if (!url) {
      url = this.resolve(side, role)
      this.urls.set(key, url)
    }
    return url
  }

  private async resolve(side: MoveSide, role: MoveRole): Promise<string> {
    const source = this.sources[side]?.[role]
    if (!source) throw new MoveRefusal('credential_not_configured', { side, role })
    if ('url' in source) return source.url
    if (!this.google) throw new MoveRefusal('google_access_unavailable')
    try {
      return await readSecretManagerText(source.secret, this.google)
    } catch {
      throw new MoveRefusal('credential_secret_unreadable', { side, role })
    }
  }
}

export async function endQuietly(client: pg.Client | null | undefined): Promise<void> {
  await client?.end().catch(() => undefined)
}
