import type { RuntimeGraphStatus } from '../../../shared/runtime-types'

export type SessionTabsInventoryPublicationHost = {
  getGraphStatus(): RuntimeGraphStatus
  getRendererGraphEpoch(): number
}

export class SessionTabsInventoryPublication {
  private publicationEpoch: number | null = null
  private readonly publicationWaiters = new Set<() => void>()

  constructor(private readonly host: SessionTabsInventoryPublicationHost) {}

  get epoch(): number | null {
    return this.publicationEpoch
  }

  get pendingWaiterCount(): number {
    return this.publicationWaiters.size
  }

  reset(): void {
    this.publicationEpoch = null
  }

  addPublicationListener(listener: () => void): void {
    this.publicationWaiters.add(listener)
  }

  removePublicationListener(listener: () => void): void {
    this.publicationWaiters.delete(listener)
  }

  waitForSessionTabsInventoryPublication(signal?: AbortSignal): Promise<void> {
    if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.publicationWaiters.delete(onPublished)
        signal?.removeEventListener('abort', onAbort)
      }
      const onPublished = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      this.publicationWaiters.add(onPublished)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
      } else if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
        onPublished()
      }
    })
  }

  getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return this.host.getGraphStatus() === 'ready' &&
      this.publicationEpoch === this.host.getRendererGraphEpoch()
      ? this.host.getRendererGraphEpoch()
      : null
  }

  markSessionTabsInventoryPublished(): void {
    if (this.publicationEpoch === this.host.getRendererGraphEpoch()) {
      return
    }
    this.publicationEpoch = this.host.getRendererGraphEpoch()
    for (const publish of Array.from(this.publicationWaiters)) {
      publish()
    }
  }
}
