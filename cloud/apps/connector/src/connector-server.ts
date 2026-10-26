import { createAdaptorServer } from '@hono/node-server'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_LIMITS,
  CONNECTOR_PATHS,
  ConnectorHostChallengeRequestSchema,
  ConnectorHostSessionRequestSchema,
  ConnectorSignInPollRequestSchema,
  ConnectorSignInStartRequestSchema,
  ConnectorSignOutRequestSchema,
  type ConnectorSignInStartResponse
} from '@orca-cloud/connector-contract'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ConnectorConfig } from './config.js'
import { createConnectorHandshake } from './connector-host-handshake.js'
import { ConnectorHostLinks } from './host-links.js'
import { limitByClientIp, RateLimiter, readClientIp } from './rate-limiter.js'
import { RequestDrain } from './request-drain.js'
import { ConnectorSignInRequests, formatUserCode } from './sign-in-requests.js'
import { SignedCookies } from './signed-cookies.js'
import { registerWebRoutes } from './web-routes.js'
import { ConnectorWebSignIn } from './web-sign-in.js'

const MAX_BODY_BYTES = 64 * 1024
const UNAUTHENTICATED_PER_MINUTE_PER_IP = 30
const AUTHENTICATED_PER_MINUTE_PER_IP = 6_000
const AUTHENTICATED_PER_MINUTE_PER_HOST = 600
// Bounds guessing user codes from a signed-in browser.
const CODE_ATTEMPTS_PER_MINUTE_PER_ACCOUNT = 10
// Set by the load balancer when it is configured to forward the client's rough location.
const CLIENT_LOCATION_HEADER = 'x-client-geo-location'

export type ConnectorServerOptions = {
  now?: () => number
  // The auth service is reached through this; tests pass a fake issuer.
  fetch?: typeof fetch
}

type MachineVariables = { hostId: string }

function readBearer(header: string | undefined): string | null {
  const [scheme, token] = header?.split(' ') ?? []
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

async function readJson(context: Context): Promise<unknown> {
  return await context.req.json().catch(() => null)
}

export function createConnectorServer(
  config: ConnectorConfig,
  database: CloudDatabase,
  options: ConnectorServerOptions = {}
) {
  const now = options.now ?? Date.now
  const { challenges, sessions } = createConnectorHandshake(database, config.publicUrl, now)
  const hostLinks = new ConnectorHostLinks(database, now)
  const signIns = new ConnectorSignInRequests(database, now)
  const web = new ConnectorWebSignIn(
    config,
    new SignedCookies(config.cookieSecret, now),
    options.fetch ?? fetch
  )
  const limitUnauthenticated = limitByClientIp(
    new RateLimiter(UNAUTHENTICATED_PER_MINUTE_PER_IP, now),
    config.trustedProxyHops
  )
  const limitAuthenticated = limitByClientIp(
    new RateLimiter(AUTHENTICATED_PER_MINUTE_PER_IP, now),
    config.trustedProxyHops
  )
  const hostRequests = new RateLimiter(AUTHENTICATED_PER_MINUTE_PER_HOST, now)
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => context.json({ error: 'request_too_large' }, 413)
  })

  const app = new Hono<{ Variables: MachineVariables }>()
  const requestDrain = new RequestDrain()
  app.use('*', requestDrain.middleware)
  // Default logging can carry row detail; log only the error's name.
  app.onError((error, context) => {
    console.warn(
      JSON.stringify({
        event: 'orca_connector_request_failed',
        error: error instanceof Error ? error.name : 'unknown'
      })
    )
    return context.json({ error: 'internal' }, 500)
  })

  app.get('/health', (context) => context.json({ ok: true, mode: config.mode }))
  app.get('/ready', limitUnauthenticated, async (context) =>
    (await database.query('SELECT 1 AS ready').then(
      () => true,
      () => false
    ))
      ? context.json({ ok: true })
      : context.json({ error: 'dependency_unavailable' }, 503)
  )

  if (config.mode === 'validation') {
    app.use('*', async (context) => context.json({ error: 'validation_only' }, 503))
  }

  // The session lookup joins the host link, so a revoked machine is refused on every call.
  const machineSession: MiddlewareHandler<{ Variables: MachineVariables }> = async (
    context,
    next
  ) => {
    const bearer = readBearer(context.req.header('authorization'))
    const session = bearer ? await sessions.resolve(bearer) : null
    if (!session?.ok) {
      if (session?.reason === 'host_not_linked' || session?.reason === 'host_revoked') {
        return context.json({ error: session.reason }, 403)
      }
      const error = session?.reason === 'session_expired' ? 'session_expired' : 'invalid_token'
      return context.json({ error }, 401)
    }
    if (!hostRequests.allow(session.hostFingerprint)) {
      return context.json({ error: 'rate_limited' }, 429)
    }
    context.set('hostId', session.hostFingerprint)
    await next()
    return
  }
  app.use(CONNECTOR_PATHS.signOut, limitAuthenticated, machineSession)

  app.post(CONNECTOR_PATHS.signInStart, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorSignInStartRequestSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const location = context.req.header(CLIENT_LOCATION_HEADER)?.trim()
    const started = await signIns.start(body.data, {
      ip: readClientIp(context, config.trustedProxyHops),
      ...(location ? { location } : {})
    })
    if (started === 'rate_limited') {
      context.header('Retry-After', '60')
      return context.json({ error: 'rate_limited' }, 429)
    }
    const response: ConnectorSignInStartResponse = {
      deviceCode: started.deviceCode,
      userCode: formatUserCode(started.userCode),
      verificationUri: `${config.publicUrl}/host-login`,
      expiresAt: started.expiresAt,
      interval: CONNECTOR_LIMITS.signInPollIntervalSeconds
    }
    return context.json(response, 201)
  })

  app.post(CONNECTOR_PATHS.signInPoll, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorSignInPollRequestSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    return context.json(await signIns.poll(body.data.deviceCode))
  })

  app.post(CONNECTOR_PATHS.signOut, limitBody, async (context) => {
    if (!ConnectorSignOutRequestSchema.safeParse(await readJson(context)).success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    await hostLinks.unbind(context.get('hostId'))
    return context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.hostChallenge, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorHostChallengeRequestSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const issued = await challenges.issue(body.data.hostPublicKeyB64)
    if (!issued) return context.json({ error: 'invalid_request' }, 400)
    const { hostFingerprint: _bound, ...response } = issued
    return context.json(response)
  })

  app.post(CONNECTOR_PATHS.hostSession, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorHostSessionRequestSchema.safeParse(await readJson(context))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const verification = await challenges.verify(body.data.challengeId, body.data.proofB64)
    if (!verification.ok) {
      const error = verification.reason === 'unknown_challenge' ? 'invalid_challenge' : 'invalid_proof'
      return context.json({ error }, 401)
    }
    const hostId = verification.hostFingerprint
    const link = await hostLinks.status(hostId)
    if (link !== 'linked') {
      return context.json({ error: link === 'revoked' ? 'host_revoked' : 'host_not_linked' }, 403)
    }
    const { sessionToken, expiresAt } = await sessions.create(hostId)
    return context.json({ sessionToken, expiresAt, hostId })
  })

  registerWebRoutes(app, {
    web,
    signIns,
    hostLinks,
    now,
    limitUnauthenticated,
    limitBody,
    codeAttempts: new RateLimiter(CODE_ATTEMPTS_PER_MINUTE_PER_ACCOUNT, now)
  })

  return {
    app,
    requestDrain,
    server: createAdaptorServer(app),
    challenges,
    sessions,
    signIns
  }
}
