import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { HostSessionLookup, HostSessionStore } from '@orca-cloud/host-handshake'
import type { Context, MiddlewareHandler } from 'hono'
import { lockConnectorHost } from './connector-host-handshake.js'
import type { RateLimiter } from './rate-limiter.js'

export type MachineVariables = { hostId: string; sessionId: string }
export type MachineEnv = { Variables: MachineVariables }

type CurrentSession = Extract<HostSessionLookup, { ok: true }>

function readBearer(header: string | undefined): string | null {
  const [scheme, token] = header?.split(' ') ?? []
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

function refuse(context: Context, lookup: HostSessionLookup | null): Response {
  const reason = lookup && !lookup.ok ? lookup.reason : 'unknown_session'
  if (reason === 'host_not_linked' || reason === 'host_revoked') {
    return context.json({ error: reason }, 403)
  }
  return context.json({ error: reason === 'session_expired' ? 'session_expired' : 'invalid_token' }, 401)
}

// The session lookup joins the host link, so a revoked machine is refused on every call.
export function createMachineSession(deps: {
  database: CloudDatabase
  sessions: HostSessionStore
  hostRequests: RateLimiter
}) {
  const { database, sessions, hostRequests } = deps

  const middleware: MiddlewareHandler<MachineEnv> = async (context, next) => {
    const bearer = readBearer(context.req.header('authorization'))
    const session = bearer ? await sessions.resolve(bearer) : null
    if (!session?.ok) {
      return refuse(context, session)
    }
    if (!hostRequests.allow(session.hostFingerprint)) {
      return context.json({ error: 'rate_limited' }, 429)
    }
    context.set('hostId', session.hostFingerprint)
    context.set('sessionId', session.sessionId)
    await next()
  }

  // Runs under the host lock that every link and session change takes, against the session as it
  // stands there: one point where a poll or ack either sees a revoke or hello whole, or not at all.
  async function locked<T>(
    context: Context<MachineEnv>,
    run: (transaction: CloudDatabase, session: CurrentSession) => Promise<T>
  ): Promise<T | Response> {
    const bearer = readBearer(context.req.header('authorization')) ?? ''
    const hostId = context.get('hostId')
    return await database.transaction(async (transaction) => {
      await lockConnectorHost(transaction, hostId)
      const session = await sessions.resolve(bearer, transaction)
      if (!session.ok || session.hostFingerprint !== hostId) {
        return refuse(context, session)
      }
      return await run(transaction, session)
    })
  }

  return { middleware, locked }
}

export type MachineSession = ReturnType<typeof createMachineSession>
