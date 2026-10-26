import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
// Mention and delegation as the app itself; actor=app can't also ask for admin.
const INSTALL_SCOPES = 'read,write,app:assignable,app:mentionable'
const INSTALL_STATE_TTL_MS = 10 * 60_000
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
// Under the database's 5 s idle-in-transaction limit, since a refresh runs inside the row lock.
const LINEAR_TOKEN_TIMEOUT_MS = 4_000

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive()
})
const TokenErrorSchema = z.object({ error: z.string().min(1) })

export type LinearTokens = { accessToken: string; refreshToken: string; expiresAt: number }

export type LinearTokenGrant =
  | { grantType: 'authorization_code'; code: string; redirectUri: string }
  | { grantType: 'refresh_token'; refreshToken: string }

export type LinearTokenResult =
  | { kind: 'ok'; tokens: LinearTokens }
  // Linear refused the grant (e.g. invalid_grant): a new install is the only way back.
  | { kind: 'failed'; error: string }
  // The grant may or may not have been used; a refresh can be replayed for 30 minutes.
  | { kind: 'unknown' }

export type LinearTokenEndpoint = (grant: LinearTokenGrant) => Promise<LinearTokenResult>

export function createLinearTokenEndpoint(
  client: { clientId: string; clientSecret: string },
  request: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now
): LinearTokenEndpoint {
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')
  return async (grant) => {
    const form: Record<string, string> =
      grant.grantType === 'authorization_code'
        ? { grant_type: grant.grantType, code: grant.code, redirect_uri: grant.redirectUri }
        : { grant_type: grant.grantType, refresh_token: grant.refreshToken }
    let response: Response
    try {
      response = await request(LINEAR_TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(LINEAR_TOKEN_TIMEOUT_MS)
      })
    } catch {
      return { kind: 'unknown' }
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const tokens = TokenResponseSchema.safeParse(body)
      return tokens.success
        ? {
            kind: 'ok',
            tokens: {
              accessToken: tokens.data.access_token,
              refreshToken: tokens.data.refresh_token,
              expiresAt: now() + tokens.data.expires_in * 1000
            }
          }
        : { kind: 'unknown' }
    }
    const refused = TokenErrorSchema.safeParse(body)
    return response.status === 400 && refused.success
      ? { kind: 'failed', error: refused.data.error }
      : { kind: 'unknown' }
  }
}

function stateMac(key: string, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

// The operator's install link: a workspace admin approves it, and Linear sends the code to our callback.
export function linearInstallUrl(input: {
  clientId: string
  redirectUri: string
  stateKey: string
  nowMs: number
}): string {
  const payload = `${input.nowMs + INSTALL_STATE_TTL_MS}.${randomBytes(16).toString('base64url')}`
  const url = new URL(LINEAR_AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: INSTALL_SCOPES,
    actor: 'app',
    state: `${payload}.${stateMac(input.stateKey, payload).toString('base64url')}`
  }).toString()
  return url.toString()
}

// True for a state we minted that has not expired; anything else never reaches the token exchange.
export function verifyInstallState(stateKey: string, state: string, nowMs: number): boolean {
  const [expiresAt, nonce, mac, ...rest] = state.split('.')
  if (!expiresAt || !nonce || !mac || rest.length > 0 || !/^\d+$/.test(expiresAt)) {
    return false
  }
  const expected = stateMac(stateKey, `${expiresAt}.${nonce}`)
  const received = Buffer.from(mac, 'base64url')
  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected) &&
    nowMs <= Number(expiresAt)
  )
}
