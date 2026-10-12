import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { listServerRepos, type ListedRepo } from './server-repos'

type ServerRepo<Repo> = Repo & { executionHostId: ExecutionHostId }

/**
 * Each reachable server's repos by host, filled in as each server answers, so a slow server never
 * holds back the desktop's own list or another server's. A new `generation` re-reads them.
 */
export function useServerRepos<Repo extends ListedRepo>(
  serverClients: ReadonlyMap<ExecutionHostId, RpcClient>,
  active: boolean,
  generation = 0
): ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]> {
  const [serverRepos, setServerRepos] = useState<ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]>>(
    () => new Map()
  )

  useEffect(() => {
    // A server the phone can no longer reach takes its repos with it.
    setServerRepos((previous) => {
      const kept = [...previous].filter(([host]) => serverClients.has(host))
      return kept.length === previous.size ? previous : new Map(kept)
    })
    if (!active) {
      return
    }
    let stale = false
    for (const [executionHostId, serverClient] of serverClients) {
      void listServerRepos<Repo>(executionHostId, serverClient).then((listed) => {
        if (!stale && listed) {
          setServerRepos((previous) => new Map(previous).set(executionHostId, listed))
        }
      })
    }
    return () => {
      stale = true
    }
  }, [active, generation, serverClients])

  return serverRepos
}
