import { createHash } from 'node:crypto'
import type {
  AgentSessionChoiceCatalog,
  AgentSessionModelCatalogResult
} from '../../../shared/agent-session-wire'
import { AgentModelCatalogListingWaiters } from './agent-model-catalog-listing-waiters'
import {
  agentModelCatalogEntry,
  agentModelCatalogResultFromEntry,
  agentModelCatalogSessionObservation,
  retainedAgentModelCatalogModels
} from './agent-model-catalog-entry'
import type { AgentModelCatalogLiveListing } from './agent-model-catalog-store'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'

export function createAgentModelCatalogProcessObservations(
  deps: Pick<AgentModelCatalogServiceDeps, 'processScope' | 'getRecord' | 'processListingPending'>
) {
  const listings = new Map<
    string,
    {
      scope: string
      listing: AgentModelCatalogLiveListing
      genuineModels: AgentModelCatalogLiveListing['models']
      at: number
    }
  >()
  const work = new Map<string, { scope: string; promise: Promise<void> }>()
  const pending = (id: string): boolean =>
    !!deps.processScope?.(id) &&
    (deps.processListingPending?.(id) === true || work.get(id)?.scope === deps.processScope?.(id))
  const current = (id: string) => {
    const saved = listings.get(id)
    return saved?.scope === deps.processScope?.(id) ? saved : null
  }
  const waiters = new AgentModelCatalogListingWaiters((id) => {
    const saved = current(id)
    return saved && (saved.listing.listingComplete ?? saved.listing.complete) !== false
      ? saved
      : null
  }, pending)
  const processCatalog = (sessionId: string): AgentSessionChoiceCatalog | null => {
    const scope = deps.processScope?.(sessionId)
    const record = deps.getRecord(sessionId)
    if (!scope || !record || record.provider === 'codex') {
      return null
    }
    const saved = listings.get(sessionId)
    const observed = saved?.scope === scope ? saved : undefined
    const listing = observed?.listing
    const complete = listing !== undefined && listing.complete !== false
    return {
      authority: 'session',
      scopeId: createHash('sha256').update(scope).digest('hex'),
      models: listing?.models ?? [],
      complete,
      freshForMs: complete && observed ? Math.max(0, 120_000 - (Date.now() - observed.at)) : 0,
      ...(listing?.fastModeSupport ? { fastModeSupport: listing.fastModeSupport } : {})
    }
  }
  return {
    read: processCatalog,
    pending,
    wait: (id: string) => waiters.wait(id, current(id)),
    async readFlat(params: { sessionId?: string; legacy?: boolean; waitForListing?: boolean }) {
      if (!params.legacy || !params.sessionId) {
        return null
      }
      const answer = this.flat(params.sessionId)
      if (answer?.origin === 'unknown' && params.waitForListing && pending(params.sessionId)) {
        await waiters.wait(params.sessionId, current(params.sessionId))
      }
      return this.flat(params.sessionId)
    },
    notify: (id: string) => waiters.notify(id),
    track(id: string, promise: Promise<void>) {
      const scope = deps.processScope?.(id)
      if (!scope) {
        return
      }
      const tracked = { scope, promise }
      work.set(id, tracked)
      void promise
        .catch(() => {})
        .finally(() => {
          if (work.get(id) === tracked) {
            work.delete(id)
          }
          waiters.notify(id)
        })
    },
    flat(id: string): AgentSessionModelCatalogResult | null {
      if (!processCatalog(id)) {
        return null
      }
      const saved = current(id)
      const listing = saved?.listing
      if (!saved || !listing || (listing.listingComplete ?? listing.complete) === false) {
        return { origin: 'unknown', ...(pending(id) ? { listingInProgress: true } : {}) }
      }
      const observation = agentModelCatalogSessionObservation(listing)
      return agentModelCatalogResultFromEntry(
        agentModelCatalogEntry(
          '',
          saved.scope,
          {
            ...observation,
            at: saved.at,
            complete: true,
            models: saved.genuineModels
          },
          'session-advisory'
        ),
        true,
        false
      )
    },
    get: (sessionId: string) => listings.get(sessionId),
    clear: () => {
      listings.clear()
      work.clear()
      waiters.close()
    },
    record(
      sessionId: string,
      scope: string | null | undefined,
      listing: AgentModelCatalogLiveListing
    ) {
      if (scope) {
        if (listings.size >= 256 && !listings.has(sessionId)) {
          const oldest = listings.keys().next().value
          if (oldest !== undefined) {
            listings.delete(oldest)
          }
        }
        const prior = listings.get(sessionId)
        const display =
          listing.models.length === 0 && prior?.scope === scope
            ? { ...prior.listing, complete: false, listingComplete: false }
            : listing
        const genuineModels =
          (display.listingComplete ?? display.complete) === false
            ? []
            : retainedAgentModelCatalogModels(
                prior?.scope === scope ? { models: prior.genuineModels } : undefined,
                display
              )
        listings.set(sessionId, { scope, listing: display, genuineModels, at: Date.now() })
        waiters.notify(sessionId)
      }
    }
  }
}
