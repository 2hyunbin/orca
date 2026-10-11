import { describe, expect, it } from 'vitest'
import type { RuntimeGraphStatus } from '../../../shared/runtime-types'
import { SessionTabsInventoryPublication } from './session-tabs-inventory-publication'

function inventoryPublication() {
  const graph: { status: RuntimeGraphStatus; epoch: number } = { status: 'ready', epoch: 1 }
  const publication = new SessionTabsInventoryPublication({
    getGraphStatus: () => graph.status,
    getRendererGraphEpoch: () => graph.epoch
  })
  return { graph, publication }
}

describe('session tab inventory publication ownership', () => {
  it('keeps publication and waiters isolated between runtime owners', async () => {
    const first = inventoryPublication()
    const second = inventoryPublication()
    const firstWait = first.publication.waitForSessionTabsInventoryPublication()
    const secondWait = second.publication.waitForSessionTabsInventoryPublication()

    first.publication.markSessionTabsInventoryPublished()
    await firstWait
    expect(first.publication.pendingWaiterCount).toBe(0)
    expect(second.publication.pendingWaiterCount).toBe(1)
    expect(second.publication.epoch).toBeNull()

    second.publication.markSessionTabsInventoryPublished()
    await secondWait
  })

  it('uses the live graph status and epoch after the owner was constructed', async () => {
    const { graph, publication } = inventoryPublication()
    publication.markSessionTabsInventoryPublished()
    graph.status = 'reloading'
    graph.epoch = 2
    expect(publication.getAuthoritativeSessionTabsInventoryEpoch()).toBeNull()
    const pending = publication.waitForSessionTabsInventoryPublication()
    expect(publication.pendingWaiterCount).toBe(1)

    graph.status = 'ready'
    publication.markSessionTabsInventoryPublished()
    await pending
    expect(publication.getAuthoritativeSessionTabsInventoryEpoch()).toBe(2)
  })

  it('keeps an unpublished waiter until the reset graph publishes', async () => {
    const { publication } = inventoryPublication()
    const pending = publication.waitForSessionTabsInventoryPublication()
    publication.reset()
    expect(publication.pendingWaiterCount).toBe(1)

    publication.markSessionTabsInventoryPublished()
    await pending
  })

  it('removes an already-aborted waiter before a later publication', async () => {
    const { publication } = inventoryPublication()
    const controller = new AbortController()
    controller.abort()

    await expect(
      publication.waitForSessionTabsInventoryPublication(controller.signal)
    ).rejects.toThrow('client_disconnected')
    expect(publication.pendingWaiterCount).toBe(0)
    publication.markSessionTabsInventoryPublished()
  })

  it('removes a newly-aborted waiter without cancelling another caller', async () => {
    const { publication } = inventoryPublication()
    const controller = new AbortController()
    const cancelled = publication.waitForSessionTabsInventoryPublication(controller.signal)
    const surviving = publication.waitForSessionTabsInventoryPublication()
    controller.abort()

    await expect(cancelled).rejects.toThrow('client_disconnected')
    expect(publication.pendingWaiterCount).toBe(1)
    publication.markSessionTabsInventoryPublished()
    await surviving
  })

  it('notifies a captured listener set once per epoch', () => {
    const { graph, publication } = inventoryPublication()
    const calls: string[] = []
    const addedDuringPublication = (): void => {
      calls.push('added')
      publication.removePublicationListener(addedDuringPublication)
    }
    const first = (): void => {
      calls.push('first')
      publication.removePublicationListener(first)
      publication.addPublicationListener(addedDuringPublication)
    }
    publication.addPublicationListener(first)

    publication.markSessionTabsInventoryPublished()
    publication.markSessionTabsInventoryPublished()
    expect(calls).toEqual(['first'])
    expect(publication.pendingWaiterCount).toBe(1)

    graph.epoch = 2
    publication.markSessionTabsInventoryPublished()
    expect(calls).toEqual(['first', 'added'])
    expect(publication.pendingWaiterCount).toBe(0)
  })
})
