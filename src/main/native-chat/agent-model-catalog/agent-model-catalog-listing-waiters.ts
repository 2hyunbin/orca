import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

export const AGENT_MODEL_CATALOG_PICKER_WAIT_MS = 30_000

/** Pickers following a fingerprint's listing work: each settles once a catalog lands, all work
 *  ends, or its fixed deadline expires. */
export class AgentModelCatalogListingWaiters<T = AgentModelCatalogEntry> {
  private readonly waiters = new Map<string, Set<() => void>>()
  private stopped = false

  constructor(
    private readonly read: (fingerprint: string) => T | null,
    private readonly listing: (fingerprint: string) => boolean
  ) {}

  wait(fingerprint: string, after?: T | null): Promise<T | null> | null {
    if (this.stopped || !this.listing(fingerprint)) {
      return null
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(fingerprint) ?? new Set<() => void>()
      let settled = false
      const finish = (entry: T | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(deadline)
        waiters.delete(check)
        if (waiters.size === 0) {
          this.waiters.delete(fingerprint)
        }
        resolve(entry)
      }
      const check = (): void => {
        const entry = this.read(fingerprint)
        if (this.stopped || (entry && entry !== after) || !this.listing(fingerprint)) {
          finish(entry)
        }
      }
      const deadline = setTimeout(
        () => finish(this.read(fingerprint)),
        AGENT_MODEL_CATALOG_PICKER_WAIT_MS
      )
      waiters.add(check)
      this.waiters.set(fingerprint, waiters)
      check()
    })
  }

  notify(fingerprint: string): void {
    for (const check of this.waiters.get(fingerprint) ?? []) {
      check()
    }
  }
  close(): void {
    this.stopped = true
    for (const key of this.waiters.keys()) {
      this.notify(key)
    }
  }
}
