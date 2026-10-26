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
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { ConnectorInbox } from './connector-inbox.js'
import type { ConnectorThreads } from './connector-threads.js'
import type { ConnectorHostLinks } from './host-links.js'
import type { InboxWaker } from './inbox-waker.js'

export type MachineVariables = { hostId: string; sessionId: string }
export type MachineEnv = { Variables: MachineVariables }

// The machine API behind a host session: hello, the held poll, confirmations and turn events.
export function registerMachineRoutes(
  app: Hono<MachineEnv>,
  deps: {
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hostLinks: ConnectorHostLinks
    waker: InboxWaker
    now: () => number
    holdMs: number
    // Re-runs the session lookup (and its link join); a Response means refuse.
    authorize: (context: Context<MachineEnv>) => Promise<Response | null>
    limitBody: MiddlewareHandler
  }
): void {
  const { inbox, threads, hostLinks, waker, now, holdMs, authorize, limitBody } = deps

  app.put(CONNECTOR_PATHS.hello, limitBody, async (context) => {
    const body = ConnectorHelloRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (body.data.contract < CONNECTOR_CONTRACT_VERSION) {
      return context.json({ error: 'client_too_old' }, 426)
    }
    await hostLinks.recordHello(context.get('hostId'), body.data)
    return context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.poll, limitBody, async (context) => {
    const body = ConnectorPollRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const hostId = context.get('hostId')
    const sessionId = context.get('sessionId')
    await hostLinks.touch(hostId)
    const unsettled = await inbox.firstPollUnsettled(hostId, sessionId)
    const holdUntil = Date.now() + holdMs
    let deliveries: ConnectorDelivery[] = []
    for (;;) {
      const waiter = waker.register(hostId)
      try {
        // Checked on every pass, so a poll held across a newer hello is sent to hello as well.
        if ((await hostLinks.helloRev(hostId)) !== body.data.helloRev) {
          return context.json({ error: 'hello_required' }, 409)
        }
        const claimed = await inbox.claim(hostId)
        deliveries = claimed.deliveries
        // Checked after every claim, so a revoke that lands while the poll is held hands out nothing.
        const refused = await authorize(context)
        if (refused) return refused
        const remaining = holdUntil - Date.now()
        const recovering = unsettled !== null && unsettled.length > 0
        if (deliveries.length > 0 || recovering || remaining <= 0 || waker.draining) break
        // A lease running out sends no notification, so wake for the next one too.
        const leaseDueMs =
          claimed.nextLeaseDueAt === null ? remaining : Math.max(0, claimed.nextLeaseDueAt - now())
        await waiter.wait(Math.min(remaining, leaseDueMs))
      } finally {
        waiter.cancel()
      }
    }
    // A failed poll leaves the session unmarked, so the next one still recovers.
    const recovered =
      unsettled !== null && (await inbox.markFirstPoll(hostId, sessionId)) ? unsettled : []
    const response: ConnectorPollResponse = {
      v: 1,
      serverNow: now(),
      holdMs,
      ...(recovered.length > 0 ? { unsettled: recovered } : {}),
      deliveries,
      ...(waker.draining ? { control: { reconnect: true as const } } : {})
    }
    return context.json(response)
  })

  app.post(CONNECTOR_PATHS.acks, limitBody, async (context) => {
    const body = ConnectorAcksRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    await inbox.acknowledge(context.get('hostId'), body.data.acks)
    return context.body(null, 204)
  })

  app.post(CONNECTOR_PATHS.events, limitBody, async (context) => {
    const body = ConnectorEventsRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    await threads.applyEvents(context.get('hostId'), body.data.events)
    return context.body(null, 204)
  })
}
