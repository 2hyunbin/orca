import {
  CONNECTOR_CONTRACT_VERSION,
  CONNECTOR_PATHS,
  ConnectorAcksRequestSchema,
  ConnectorEventsRequestSchema,
  ConnectorHelloRequestSchema,
  ConnectorPollRequestSchema,
  type ConnectorDelivery,
  type ConnectorPollResponse
} from '@orca-cloud/connector-contract'
import type { Hono, MiddlewareHandler } from 'hono'
import type { ConnectorInbox, Unsettled } from './connector-inbox.js'
import type { ConnectorThreads } from './connector-threads.js'
import type { ConnectorHostLinks } from './host-links.js'
import type { InboxWaker } from './inbox-waker.js'
import type { MachineEnv, MachineSession } from './machine-session.js'

// The machine API behind a host session: hello, the held poll, confirmations and turn events.
export function registerMachineRoutes(
  app: Hono<MachineEnv>,
  deps: {
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hostLinks: ConnectorHostLinks
    waker: InboxWaker
    session: MachineSession
    now: () => number
    holdMs: number
    limitBody: MiddlewareHandler
  }
): void {
  const { inbox, threads, hostLinks, waker, session, now, holdMs, limitBody } = deps

  app.put(CONNECTOR_PATHS.hello, limitBody, async (context) => {
    const body = ConnectorHelloRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    if (body.data.contract < CONNECTOR_CONTRACT_VERSION) {
      return context.json({ error: 'client_too_old' }, 426)
    }
    const hostId = context.get('hostId')
    const recorded = await session.locked(context, (transaction) =>
      hostLinks.recordHello(transaction, hostId, body.data)
    )
    return recorded instanceof Response ? recorded : context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.poll, limitBody, async (context) => {
    const body = ConnectorPollRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const hostId = context.get('hostId')
    const { helloRev } = body.data
    await hostLinks.touch(hostId)
    const holdUntil = Date.now() + holdMs
    let deliveries: ConnectorDelivery[] = []
    let unsettled: Unsettled[] = []
    for (;;) {
      const waiter = waker.register(hostId)
      try {
        // Each pass decides under the host lock, so a revoke or newer hello either lands before it
        // (and this refuses) or after it has committed what it hands out.
        const pass = await session.locked(context, async (transaction, current) => {
          if ((await hostLinks.helloRev(transaction, hostId)) !== helloRev) {
            return null
          }
          const recovered = await inbox.takeFirstPollUnsettled(transaction, hostId, current.sessionId)
          return { recovered, ...(await inbox.claim(transaction, hostId)) }
        })
        if (pass instanceof Response) {
          return pass
        }
        if (pass === null) {
          return context.json({ error: 'hello_required' }, 409)
        }
        deliveries = pass.deliveries
        unsettled = pass.recovered
        const remaining = holdUntil - Date.now()
        const ready = deliveries.length > 0 || unsettled.length > 0
        if (ready || remaining <= 0 || waker.draining) {
          break
        }
        // A lease running out sends no notification, so wake for the next one too.
        const leaseDueMs =
          pass.nextLeaseDueAt === null ? remaining : Math.max(0, pass.nextLeaseDueAt - now())
        await waiter.wait(Math.min(remaining, leaseDueMs))
      } finally {
        waiter.cancel()
      }
    }
    const response: ConnectorPollResponse = {
      v: 1,
      serverNow: now(),
      holdMs,
      ...(unsettled.length > 0 ? { unsettled } : {}),
      deliveries,
      ...(waker.draining ? { control: { reconnect: true as const } } : {})
    }
    return context.json(response)
  })

  app.post(CONNECTOR_PATHS.acks, limitBody, async (context) => {
    const body = ConnectorAcksRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const hostId = context.get('hostId')
    const acknowledged = await session.locked(context, (transaction) =>
      inbox.acknowledge(transaction, hostId, body.data.acks)
    )
    return acknowledged instanceof Response ? acknowledged : context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.events, limitBody, async (context) => {
    const body = ConnectorEventsRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const hostId = context.get('hostId')
    // A stale batch still answers 200: the machine has nothing to retry.
    const applied = await session.locked(context, (transaction, current) =>
      threads.applyEvents(
        transaction,
        // The connection is the host session for now; only this key changes if that does.
        { hostId, connectionId: current.sessionId },
        body.data.seq,
        body.data.events
      )
    )
    return applied instanceof Response ? applied : context.body(null, 204)
  })
}
