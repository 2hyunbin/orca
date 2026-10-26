import { randomUUID } from 'node:crypto'
import { ConnectorDeliverySchema } from '@orca-cloud/connector-contract'
import type { Env, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { ConnectorInbox } from './connector-inbox.js'
import type { ConnectorThreads } from './connector-threads.js'
import type { ConnectorHostLinks } from './host-links.js'

const DevEnqueueSchema = z.object({
  hostId: z.string().min(1),
  externalId: z.string().min(1),
  placeId: z.string().min(1).default('dev-place'),
  deliveryId: z.string().min(1).optional(),
  // The kind-specific delivery fields; the envelope is filled in below and checked by the contract.
  delivery: z.record(z.string(), z.unknown())
})

// Queues a delivery for a linked host without Slack; registered only on a loopback origin.
export function registerDevEnqueueRoute<E extends Env>(
  app: Hono<E>,
  deps: {
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hostLinks: ConnectorHostLinks
    limitBody: MiddlewareHandler
  }
): void {
  app.post('/dev/enqueue', deps.limitBody, async (context) => {
    const body = DevEnqueueSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    const { hostId, externalId, placeId } = body.data
    const deliveryId = body.data.deliveryId ?? randomUUID()
    const delivery = ConnectorDeliverySchema.safeParse({
      ...body.data.delivery,
      deliveryId,
      seq: 1,
      expiresAt: 1,
      conversation: { source: 'slack', externalId }
    })
    if (!delivery.success) return context.json({ error: 'invalid_request' }, 400)
    const accountId = await deps.hostLinks.accountOf(hostId)
    if (!accountId) return context.json({ error: 'host_not_linked' }, 404)
    await deps.threads.create({
      externalId,
      teamId: 'dev',
      channelId: 'dev',
      threadTs: externalId,
      ownerUserId: 'dev',
      accountId,
      hostId,
      placeId
    })
    if ((await deps.threads.hostOf(externalId)) !== hostId) {
      return context.json({ error: 'not_this_hosts_thread' }, 409)
    }
    const { deliveryId: _id, seq: _seq, expiresAt: _expiresAt, conversation: _c, ...rest } =
      delivery.data
    const status = await deps.inbox.enqueue({ hostId, externalId, deliveryId, body: rest })
    return context.json({ deliveryId, status })
  })
}
