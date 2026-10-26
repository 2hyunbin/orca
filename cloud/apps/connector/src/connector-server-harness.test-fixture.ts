import { createHmac, randomUUID } from 'node:crypto'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_PATHS,
  ConnectorHostChallengeResponseSchema,
  ConnectorSignInStartResponseSchema
} from '@orca-cloud/connector-contract'
import { buildHostProofMacInput, type HostProofDomains } from '@orca-cloud/push-contract'
import pg from 'pg'
import nacl from 'tweetnacl'
import type { ConnectorConfig } from './config.js'
import { openConnectorDatabase, openInMemoryConnectorDatabase } from './connector-database.js'
import { CONNECTOR_HOST_PROOF_DOMAINS } from './connector-host-handshake.js'
import { createConnectorServer } from './connector-server.js'

export const PUBLIC_URL = 'https://connector.onorca.dev'
export const AUTH_URL = 'https://auth.onorca.dev'
export const HOST_IP = '203.0.113.7'

// Real Postgres when the CI service is present; each harness gets its own schema.
const testDatabaseUrl = process.env.ORCA_CONNECTOR_TEST_DATABASE_URL

export function testConnectorConfig(): ConnectorConfig {
  return {
    mode: 'active',
    port: 0,
    publicUrl: PUBLIC_URL,
    dataDir: './data/connector-test',
    databasePoolMax: 4,
    authUrl: AUTH_URL,
    authClientId: 'orca-connector',
    cookieSecret: 'test-cookie-secret-that-is-at-least-32-chars',
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

// Stands in for the auth service: each code it hands out signs in as the queued account.
export function fakeIssuer() {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let account = { userId: 'user-1', email: 'ada@example.com' }
  let logoutStatus = 200
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ path, body })
    if (path === '/v1/desktop/auth/session') {
      return Response.json({
        accessToken: 'access',
        refreshToken: `refresh-${account.userId}`,
        expiresAt: 0,
        cloud: { cloudProfileId: 'profile', ...account, linkedAt: 0 },
        capabilities: { flags: {}, refreshedAt: 0 }
      })
    }
    if (path === '/v1/desktop/auth/logout') {
      return Response.json({ ok: logoutStatus === 200 }, { status: logoutStatus })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  return {
    calls,
    fetch: fetchImpl,
    signInAs: (next: { userId: string; email: string }) => {
      account = next
    },
    failLogout: () => {
      logoutStatus = 503
    }
  }
}

export function hostKeypair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export const publicKeyB64 = (host: nacl.BoxKeyPair): string =>
  Buffer.from(host.publicKey).toString('base64')

// Opens the sealed challenge and answers it under `domains` (the connector's unless a test crosses them).
export function answerChallenge(
  challenge: { gatewayEphemeralPublicKeyB64: string; nonceB64: string; ciphertextB64: string },
  host: nacl.BoxKeyPair,
  domains: HostProofDomains = CONNECTOR_HOST_PROOF_DOMAINS
): string {
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.gatewayEphemeralPublicKeyB64, 'base64'),
    host.secretKey
  )
  if (!plaintext) throw new Error('challenge did not open')
  const bytes = Buffer.from(plaintext)
  const lengthAt = bytes.indexOf(0) + 1
  const transcript = bytes.subarray(lengthAt + 4, lengthAt + 4 + bytes.readUInt32BE(lengthAt))
  const secret = bytes.subarray(bytes.byteLength - 32)
  return createHmac('sha256', secret).update(buildHostProofMacInput(domains, transcript)).digest('base64')
}

// A browser for app.request: keeps cookies across requests and reads hidden form fields.
export function testBrowser(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const jar = new Map<string, string>()
  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('x-forwarded-for', HOST_IP)
    if (jar.size > 0) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const response = await request(path, { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';')
      const [name, ...value] = (pair ?? '').split('=')
      if (!name) continue
      if (attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name)
      else jar.set(name, value.join('='))
    }
    return response
  }
  return {
    jar,
    get: (path: string) => send(path),
    post: (path: string, form: Record<string, string>) =>
      send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString()
      })
  }
}

export function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)
  if (!match?.[1]) throw new Error(`missing hidden field ${name}`)
  return match[1]
}

// Holds the first transaction statement starting with `prefix` until release(), locks still held.
export function pauseBefore(database: CloudDatabase, prefix: string) {
  let reached!: () => void
  const atStatement = new Promise<void>((resolve) => (reached = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let paused = false
  const wrap = (inner: CloudDatabase): CloudDatabase => ({
    dialect: inner.dialect,
    query: async (sql, params) => {
      if (!paused && sql.trimStart().startsWith(prefix)) {
        paused = true
        reached()
        await released
      }
      return await inner.query(sql, params)
    },
    transaction: (run) => inner.transaction((transaction) => run(wrap(transaction))),
    lockQuotaScope: (key) => inner.lockQuotaScope(key),
    tryLockScope: (key) => inner.tryLockScope(key),
    tryLockSharedScope: (key) => inner.tryLockSharedScope(key),
    close: () => inner.close()
  })
  return { database: wrap(database), atStatement, release }
}

export async function createConnectorHarness(
  config: Partial<ConnectorConfig> = {},
  wrapDatabase: (database: CloudDatabase) => CloudDatabase = (database) => database
) {
  let now = 1_800_000_000_000
  const issuer = fakeIssuer()
  const database = await openTestDatabase()
  const runtime = createConnectorServer({ ...testConnectorConfig(), ...config }, wrapDatabase(database), {
    now: () => now,
    fetch: issuer.fetch
  })
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(runtime.app.request(path, init))
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': HOST_IP, ...headers },
      body: JSON.stringify(body)
    })

  // Signs a browser in through the fake issuer, as the redirect round trip would.
  async function signedInBrowser(account = { userId: 'user-1', email: 'ada@example.com' }) {
    issuer.signInAs(account)
    const browser = testBrowser(request)
    const redirect = await browser.get('/host-login')
    const authorize = new URL(redirect.headers.get('location') ?? '')
    await browser.get(`/auth/callback?code=code-1&state=${authorize.searchParams.get('state')}`)
    return browser
  }

  async function startSignIn(
    host: nacl.BoxKeyPair | string,
    headers: Record<string, string> = {}
  ) {
    const hostPublicKeyB64 = typeof host === 'string' ? host : publicKeyB64(host)
    const response = await json(
      CONNECTOR_PATHS.signInStart,
      { v: 1, hostPublicKeyB64, hostName: 'build-box', platform: 'linux', runtime: 'serve', orcaVersion: '1.4.230' },
      headers
    )
    const body: unknown = await response.json()
    return { response, body, started: ConnectorSignInStartResponseSchema.safeParse(body).data }
  }

  async function approve(browser: ReturnType<typeof testBrowser>, userCode: string, allow = true) {
    const entry = await browser.get('/host-login')
    const confirm = await browser.post('/host-login', {
      csrf: hiddenField(await entry.text(), 'csrf'),
      userCode
    })
    const page = await confirm.text()
    return await browser.post('/host-login/decision', {
      csrf: hiddenField(page, 'csrf'),
      userCode: hiddenField(page, 'userCode'),
      decision: allow ? 'allow' : 'deny'
    })
  }

  async function machineSession(host: nacl.BoxKeyPair): Promise<Response> {
    const challenge = ConnectorHostChallengeResponseSchema.parse(
      await (
        await json(CONNECTOR_PATHS.hostChallenge, { v: 1, hostPublicKeyB64: publicKeyB64(host) })
      ).json()
    )
    return await json(CONNECTOR_PATHS.hostSession, {
      v: 1,
      challengeId: challenge.challengeId,
      proofB64: answerChallenge(challenge, host)
    })
  }

  return {
    runtime,
    database,
    issuer,
    request,
    json,
    signedInBrowser,
    startSignIn,
    approve,
    machineSession,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now
  }
}
