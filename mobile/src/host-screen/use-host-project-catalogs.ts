import { useEffect, useMemo, useState } from 'react'
import {
  foldHostProjectCatalogs,
  type AllHostProjectCatalog,
  type HostProjectCatalog
} from '../../../src/shared/all-host-project-catalog'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import { reachableServerClients } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  DESKTOP_PROJECT_CATALOG_HOST_ID,
  fetchHostProjectCatalog
} from '../worktree/host-project-catalog'

const PROJECT_CATALOG_REFRESH_MS = 60_000

type CatalogsByHost = ReadonlyMap<ExecutionHostId, HostProjectCatalog>

// Why: a remount must not regroup rows under fallback keys until the next answer; the keys are
// what collapsed state is stored under.
const lastCatalogsByDesktop = new Map<string, CatalogsByHost>()
const NO_CATALOGS: CatalogsByHost = new Map()

function cachedCatalogs(hostId: string | undefined): CatalogsByHost {
  return (hostId && lastCatalogsByDesktop.get(hostId)) || NO_CATALOGS
}

/**
 * The desktop's and each server's project catalog, folded the way the desktop renderer folds them.
 * Null until the desktop's own catalog has answered once. A host that fails to answer keeps its
 * last catalog; a server the desktop no longer lists drops its own.
 */
export function useHostProjectCatalogs(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  hostCapabilities: readonly string[]
  servers: readonly MobileRelayHost[]
}): AllHostProjectCatalog | null {
  const { client, connState, hostId, hostCapabilities, servers } = args
  const [held, setHeld] = useState<{ hostId: string | undefined; catalogs: CatalogsByHost }>(
    () => ({ hostId, catalogs: cachedCatalogs(hostId) })
  )
  const catalogs = held.hostId === hostId ? held.catalogs : cachedCatalogs(hostId)
  // Keyed on the ready set, not the feed's rows: a health or label change re-lists nothing.
  const readyKey = servers
    .filter((server) => server.relay === 'ready')
    .map((server) => server.hostId)
    .sort()
    .join('\n')
  const serverClients = useMemo(
    () => reachableServerClients(client, hostCapabilities, servers),
    [client, hostCapabilities, readyKey]
  )
  const serverOrder = useMemo(() => servers.map((server) => server.hostId), [servers])

  useEffect(() => {
    if (held.hostId && held.catalogs.size > 0) {
      lastCatalogsByDesktop.set(held.hostId, held.catalogs)
    }
  }, [held])

  useEffect(() => {
    if (!client || connState !== 'connected' || !hostId) {
      return
    }
    let stale = false
    const store = (catalog: HostProjectCatalog | null): void => {
      if (stale || !catalog) {
        return
      }
      setHeld((previous) => {
        const base = previous.hostId === hostId ? previous.catalogs : cachedCatalogs(hostId)
        if (JSON.stringify(base.get(catalog.hostId)) === JSON.stringify(catalog)) {
          return previous.hostId === hostId ? previous : { hostId, catalogs: base }
        }
        return { hostId, catalogs: new Map(base).set(catalog.hostId, catalog) }
      })
    }
    const refresh = (): void => {
      void fetchHostProjectCatalog(client, DESKTOP_PROJECT_CATALOG_HOST_ID).then(store)
      for (const [serverHostId, serverClient] of serverClients) {
        void fetchHostProjectCatalog(serverClient, serverHostId).then(store)
      }
    }
    refresh()
    const timer = setInterval(refresh, PROJECT_CATALOG_REFRESH_MS)
    return () => {
      stale = true
      clearInterval(timer)
    }
  }, [client, connState, hostId, serverClients])

  return useMemo(() => {
    const desktop = catalogs.get(DESKTOP_PROJECT_CATALOG_HOST_ID)
    if (!desktop) {
      return null
    }
    // Desktop first, then servers in the desktop's order, as its renderer loads them.
    return foldHostProjectCatalogs([
      desktop,
      ...serverOrder.flatMap((server) => {
        const catalog = catalogs.get(server)
        return catalog ? [catalog] : []
      })
    ])
  }, [catalogs, serverOrder])
}
