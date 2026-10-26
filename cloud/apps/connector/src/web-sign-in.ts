import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { ConnectorConfig } from './config.js'
import type { ConnectorAccount } from './host-links.js'
import type { SignedCookies } from './signed-cookies.js'
import { messagePage } from './web-pages.js'

const SESSION_COOKIE = 'orca_connector_session'
const TRANSACTION_COOKIE = 'orca_connector_auth'
// Reused across sign-ins so the auth service links one cloud profile per browser, not one per visit.
const PROFILE_COOKIE = 'orca_connector_profile'
const SESSION_MAX_AGE_MS = 60 * 60_000
const TRANSACTION_MAX_AGE_MS = 10 * 60_000
const PROFILE_MAX_AGE_S = 365 * 24 * 60 * 60
const AUTH_REQUEST_TIMEOUT_MS = 10_000
const LOGOUT_ATTEMPTS = 2

export const WEB_RETURN_PATHS = ['/host-login', '/machines'] as const
type ReturnPath = (typeof WEB_RETURN_PATHS)[number]

const SessionSchema = z.object({ accountId: z.string().min(1), email: z.string().min(1) })
const TransactionSchema = z.object({
  verifier: z.string().min(1),
  state: z.string().min(1),
  nonce: z.string().min(1),
  localProfileId: z.string().min(1),
  returnTo: z.enum(WEB_RETURN_PATHS)
})
// Only what the connector keeps from the auth service's session exchange.
const SessionExchangeSchema = z.object({
  refreshToken: z.string().min(1),
  cloud: z.object({ userId: z.string().min(1), email: z.string().min(1) })
})

export type WebSession = { account: ConnectorAccount; csrf: string }

const random = (bytes: number): string => randomBytes(bytes).toString('base64url')

function signInFailed(context: Context, returnTo: string, status: 400 | 502): Response {
  return context.html(
    messagePage('Sign-in failed', 'Orca sign-in did not finish. Try again.', {
      href: returnTo,
      label: 'Try again'
    }),
    status
  )
}

// Orca web sign-in as a public PKCE client: the connector keeps its own short cookie and revokes the refresh token at once.
export class ConnectorWebSignIn {
  private readonly secure: boolean
  private readonly redirectUri: string

  constructor(
    private readonly config: Pick<ConnectorConfig, 'publicUrl' | 'authUrl' | 'authClientId'>,
    private readonly cookies: SignedCookies,
    private readonly fetchImpl: typeof fetch
  ) {
    this.secure = config.publicUrl.startsWith('https:')
    this.redirectUri = `${config.publicUrl}/auth/callback`
  }

  session(context: Context): WebSession | null {
    const value = getCookie(context, SESSION_COOKIE)
    const session = this.cookies.open(SESSION_COOKIE, value, SessionSchema)
    if (!session || !value) return null
    return {
      account: { id: session.accountId, email: session.email },
      csrf: this.cookies.csrfToken(value)
    }
  }

  csrfMatches(context: Context, token: string): boolean {
    const value = getCookie(context, SESSION_COOKIE)
    return value !== undefined && this.cookies.csrfMatches(value, token)
  }

  begin(context: Context, returnTo: ReturnPath): Response {
    const localProfileId = getCookie(context, PROFILE_COOKIE) ?? `connector-${random(18)}`
    const transaction = {
      verifier: random(48),
      state: random(24),
      nonce: random(24),
      localProfileId,
      returnTo
    }
    this.setCookie(
      context,
      TRANSACTION_COOKIE,
      this.cookies.seal(TRANSACTION_COOKIE, transaction, TRANSACTION_MAX_AGE_MS),
      TRANSACTION_MAX_AGE_MS / 1000
    )
    this.setCookie(context, PROFILE_COOKIE, localProfileId, PROFILE_MAX_AGE_S)
    const url = new URL('/v1/desktop/auth/authorize', this.config.authUrl)
    url.search = new URLSearchParams({
      client_id: this.config.authClientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: 'openid',
      nonce: transaction.nonce,
      state: transaction.state,
      code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      local_profile_id: localProfileId
    }).toString()
    return context.redirect(url.toString(), 302)
  }

  async complete(context: Context): Promise<Response> {
    const transaction = this.cookies.open(
      TRANSACTION_COOKIE,
      getCookie(context, TRANSACTION_COOKIE),
      TransactionSchema
    )
    deleteCookie(context, TRANSACTION_COOKIE, { path: '/' })
    const code = context.req.query('code')
    if (!transaction || !code || context.req.query('state') !== transaction.state) {
      return signInFailed(context, transaction?.returnTo ?? '/host-login', 400)
    }
    const exchanged = SessionExchangeSchema.safeParse(
      await this.authRequest('/v1/desktop/auth/session', {
        code,
        codeVerifier: transaction.verifier,
        nonce: transaction.nonce,
        redirectUri: this.redirectUri,
        state: transaction.state,
        localProfileId: transaction.localProfileId
      })
    )
    if (!exchanged.success) {
      return signInFailed(context, transaction.returnTo, 502)
    }
    // The connector needs the identity once; a refresh token left alive would be a standing credential.
    if (!(await this.revoke(exchanged.data.refreshToken))) {
      return signInFailed(context, transaction.returnTo, 502)
    }
    const { userId, email } = exchanged.data.cloud
    this.setCookie(
      context,
      SESSION_COOKIE,
      this.cookies.seal(SESSION_COOKIE, { accountId: userId, email }, SESSION_MAX_AGE_MS),
      SESSION_MAX_AGE_MS / 1000
    )
    return context.redirect(transaction.returnTo, 303)
  }

  private async revoke(refreshToken: string): Promise<boolean> {
    for (let attempt = 0; attempt < LOGOUT_ATTEMPTS; attempt++) {
      if ((await this.authRequest('/v1/desktop/auth/logout', { refreshToken })) !== null) return true
    }
    return false
  }

  // Resolves to the JSON body of a 2xx reply, otherwise null.
  private async authRequest(path: string, body: object): Promise<unknown> {
    try {
      const response = await this.fetchImpl(new URL(path, this.config.authUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        console.warn(
          JSON.stringify({ event: 'orca_connector_auth_request_failed', path, status: response.status })
        )
        return null
      }
      return await response.json()
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'orca_connector_auth_request_failed',
          path,
          error: error instanceof Error ? error.name : 'unknown'
        })
      )
      return null
    }
  }

  private setCookie(context: Context, name: string, value: string, maxAgeS: number): void {
    setCookie(context, name, value, {
      path: '/',
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
      maxAge: maxAgeS
    })
  }
}
