import { z } from 'zod'

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
