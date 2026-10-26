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
    if ((await hostLinks.helloRev(hostId)) !== body.data.helloRev) {
      return context.json({ error: 'hello_required' }, 409)
    }
    await hostLinks.touch(hostId)
    const unsettled = await inbox.firstPollUnsettled(hostId, context.get('sessionId'))
    const holdUntil = Date.now() + holdMs
    let deliveries: ConnectorDelivery[] = []
    for (;;) {
      const waiter = waker.register(hostId)
      deliveries = await inbox.claim(hostId)
      const remaining = holdUntil - Date.now()
      if (deliveries.length > 0 || unsettled.length > 0 || remaining <= 0 || waker.draining) {
        waiter.cancel()
        break
      }
      await waiter.wait(remaining)
      // A revoke while the poll was held must stop it before anything is handed out.
      const refused = await authorize(context)
      if (refused) return refused
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
