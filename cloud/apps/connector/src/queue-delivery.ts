import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { lockConnectorHost } from './connector-host-handshake.js'
import type { ConnectorInbox, DeliveryBody, EnqueueResult } from './connector-inbox.js'
import type { ConnectorThreads, NewThread } from './connector-threads.js'
import type { ConnectorHostLinks } from './host-links.js'

export type QueueResult = EnqueueResult | 'host_not_linked' | 'not_this_hosts_thread'

// One host-locked transaction checks the link, binds the thread and queues, so a revoke lands
// wholly before (nothing is queued) or after (its sweep expires what was).
export async function queueDelivery(
  deps: {
    database: CloudDatabase
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hostLinks: ConnectorHostLinks
  },
  input: { thread: Omit<NewThread, 'accountId'>; deliveryId: string; body: DeliveryBody }
): Promise<QueueResult> {
  const { hostId, externalId } = input.thread
  return await deps.database.transaction(async (transaction) => {
    await lockConnectorHost(transaction, hostId)
    const accountId = await deps.hostLinks.accountOf(transaction, hostId)
    if (!accountId) return 'host_not_linked'
    if (!(await deps.threads.bind(transaction, { ...input.thread, accountId }))) {
      return 'not_this_hosts_thread'
    }
    return await deps.inbox.enqueue(transaction, {
      hostId,
      externalId,
      deliveryId: input.deliveryId,
      body: input.body
    })
  })
}
