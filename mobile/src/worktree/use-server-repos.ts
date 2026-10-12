import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { listServerRepos, type ListedRepo } from './server-repos'

type ServerRepo<Repo> = Repo & { executionHostId: ExecutionHostId }

/**
 * Each reachable server's repos by host, filled in as each server answers, so a slow server never
 * holds back the desktop's own list or another server's. `settledHosts` are the reachable servers
 * that have answered or failed; `settled` once that is all of them. A new `generation` re-reads.
 */
export function useServerRepos<Repo extends ListedRepo>(
  serverClients: ReadonlyMap<ExecutionHostId, RpcClient>,
  active: boolean,
  generation = 0
): {
  reposByHost: ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]>
  settledHosts: ReadonlySet<ExecutionHostId>
  settled: boolean
} {
  const [reposByHost, setReposByHost] = useState<ReadonlyMap<ExecutionHostId, ServerRepo<Repo>[]>>(
    () => new Map()
  )
  const [answered, setAnswered] = useState<ReadonlySet<ExecutionHostId>>(() => new Set())

  useEffect(() => {
    // A server the phone can no longer reach takes its repos with it, and must answer again on return.
    setReposByHost((previous) => {
      const kept = [...previous].filter(([host]) => serverClients.has(host))
      return kept.length === previous.size ? previous : new Map(kept)
    })
    setAnswered((previous) => {
      const kept = [...previous].filter((host) => serverClients.has(host))
      return kept.length === previous.size ? previous : new Set(kept)
    })
    if (!active) {
      return
    }
    let stale = false
    for (const [executionHostId, serverClient] of serverClients) {
      void listServerRepos<Repo>(executionHostId, serverClient).then((listed) => {
        if (stale) {
          return
        }
        setAnswered((previous) =>
          previous.has(executionHostId) ? previous : new Set(previous).add(executionHostId)
        )
        if (listed) {
          // An unchanged answer keeps the map, so readers keyed on it do not reload.
          setReposByHost((previous) =>
            JSON.stringify(previous.get(executionHostId)) === JSON.stringify(listed)
              ? previous
              : new Map(previous).set(executionHostId, listed)
          )
        }
      })
    }
    return () => {
      stale = true
    }
  }, [active, generation, serverClients])

  const settledHosts = useMemo(
    () => new Set([...serverClients.keys()].filter((host) => answered.has(host))),
    [answered, serverClients]
  )
  return { reposByHost, settledHosts, settled: settledHosts.size === serverClients.size }
}
