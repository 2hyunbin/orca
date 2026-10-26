import { createAdaptorServer } from '@hono/node-server'
import type { CloudDatabase, CloudNotifications } from '@orca-cloud/cloud-database'
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
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ConnectorConfig } from './config.js'
import { createConnectorHandshake } from './connector-host-handshake.js'
import { ConnectorInbox } from './connector-inbox.js'
import { ConnectorThreads } from './connector-threads.js'
import { registerDevEnqueueRoute } from './dev-enqueue-route.js'
import { queueDelivery } from './queue-delivery.js'
import { ConnectorHostLinks } from './host-links.js'
import { InboxWaker } from './inbox-waker.js'
import { registerMachineRoutes } from './machine-routes.js'
import { createMachineSession, type MachineEnv } from './machine-session.js'
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

export type ConnectorServerOptions = {
  now?: () => number
  // The auth service is reached through this; tests pass a fake issuer.
  fetch?: typeof fetch
  pollHoldMs?: number
}

function isLoopbackOrigin(origin: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
}

async function readJson(context: Context): Promise<unknown> {
  return await context.req.json().catch(() => null)
}

export function createConnectorServer(
  config: ConnectorConfig,
  database: CloudDatabase,
  notifications: CloudNotifications,
  options: ConnectorServerOptions = {}
) {
  const now = options.now ?? Date.now
  const { challenges, sessions } = createConnectorHandshake(database, config.publicUrl, now)
  const inbox = new ConnectorInbox(database, notifications, now)
  const hostLinks = new ConnectorHostLinks(database, inbox, now)
  const signIns = new ConnectorSignInRequests(database, now)
  const threads = new ConnectorThreads(now)
  const waker = new InboxWaker(notifications)
  const queue = (input: Parameters<typeof queueDelivery>[1]) =>
    queueDelivery({ database, inbox, threads, hostLinks }, input)
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
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => context.json({ error: 'request_too_large' }, 413)
  })

  const app = new Hono<MachineEnv>()
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

  const machineSession = createMachineSession({
    database,
    sessions,
    hostRequests: new RateLimiter(AUTHENTICATED_PER_MINUTE_PER_HOST, now)
  })
  app.use(CONNECTOR_PATHS.signOut, limitAuthenticated, machineSession.middleware)
  app.use('/v1/connector/*', limitAuthenticated, machineSession.middleware)
  registerMachineRoutes(app, {
    inbox,
    threads,
    hostLinks,
    waker,
    session: machineSession,
    now,
    holdMs: options.pollHoldMs ?? CONNECTOR_LIMITS.initialPollHoldMs,
    limitBody
  })
  // Local development only: a stand-in for Slack ingress until it exists.
  if (isLoopbackOrigin(config.publicUrl)) {
    registerDevEnqueueRoute(app, { queue, limitBody })
  }

  app.post(CONNECTOR_PATHS.signInStart, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorSignInStartRequestSchema.safeParse(await readJson(context))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const location = config.clientLocationHeader
      ? context.req.header(config.clientLocationHeader)?.trim()
      : undefined
    const started = await signIns.start(body.data, {
      ip: readClientIp(context, config.trustedProxyHops),
      ...(location ? { location } : {})
    })
    if (started === 'invalid_key') {
      return context.json({ error: 'invalid_request' }, 400)
    }
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
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    return context.json(await signIns.poll(body.data.deviceCode))
  })

  app.post(CONNECTOR_PATHS.signOut, limitBody, async (context) => {
    if (!ConnectorSignOutRequestSchema.safeParse(await readJson(context)).success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    if (!(await hostLinks.unbind(context.get('hostId'), context.get('sessionId')))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    return context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.hostChallenge, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorHostChallengeRequestSchema.safeParse(await readJson(context))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const issued = await challenges.issue(body.data.hostPublicKeyB64)
    if (!issued) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const { hostFingerprint: _bound, ...response } = issued
    return context.json(response)
  })

  app.post(CONNECTOR_PATHS.hostSession, limitUnauthenticated, limitBody, async (context) => {
    const body = ConnectorHostSessionRequestSchema.safeParse(await readJson(context))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const verification = await challenges.verify(body.data.challengeId, body.data.proofB64)
    if (!verification.ok) {
      const error = verification.reason === 'unknown_challenge' ? 'invalid_challenge' : 'invalid_proof'
      return context.json({ error }, 401)
    }
    const hostId = verification.hostFingerprint
    const session = await sessions.create(hostId, (transaction) =>
      hostLinks.refusal(transaction, hostId)
    )
    if (typeof session === 'string') {
      return context.json({ error: session }, 403)
    }
    const { sessionToken, expiresAt } = session
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
    signIns,
    inbox,
    waker,
    queueDelivery: queue
  }
}
