import { useEffect, useRef } from 'react'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { isHostedTaskRepo, reconcileRepoSelection } from './hosted-repo-selection'
import type { useMobileTasksRouteAndItemState } from './use-mobile-tasks-route-and-item-state'

type RouteState = ReturnType<typeof useMobileTasksRouteAndItemState>

/**
 * Selection follows the list rather than the fetch, so it reconciles the same way no matter which
 * caller triggered the load. An id a server may still list is pending, never pruned: the saved
 * selection applies once every saved id is listed or every server has answered, and a later prune
 * drops only ids their host, answering now, no longer lists.
 */
export function useTaskRepoSelectionReconcile(
  model: Pick<
    RouteState,
    | 'defaultRepoSelectionRef'
    | 'repoList'
    | 'repoSelectionHydratedRef'
    | 'repos'
    | 'serverReposSettled'
    | 'settledServerHosts'
    | 'setSelectedRepoIds'
  >
): void {
  const {
    defaultRepoSelectionRef,
    repoList,
    repoSelectionHydratedRef,
    repos,
    serverReposSettled,
    settledServerHosts,
    setSelectedRepoIds
  } = model
  // The host each id was last listed on, so an id that vanished can be traced to its host.
  const hostByRepoIdRef = useRef(new Map<string, ExecutionHostId>())
  useEffect(() => {
    if (repoList.state.status !== 'loaded') {
      return
    }
    for (const repo of repos) {
      hostByRepoIdRef.current.set(repo.id, getRepoExecutionHostId(repo))
    }
    const listedIds = new Set(repos.map((repo) => repo.id))
    if (!repoSelectionHydratedRef.current) {
      const saved = defaultRepoSelectionRef.current
      if (!serverReposSettled && saved && !saved.every((id) => listedIds.has(id))) {
        return
      }
      repoSelectionHydratedRef.current = true
      setSelectedRepoIds(reconcileRepoSelection(repos, saved))
      return
    }
    const answeredFor = (id: string): boolean => {
      const host = hostByRepoIdRef.current.get(id)
      if (!host) {
        return serverReposSettled
      }
      return parseExecutionHostId(host)?.kind !== 'runtime' || settledServerHosts.has(host)
    }
    setSelectedRepoIds((current) => {
      if (current.size === 0) {
        return current
      }
      const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
      const next = new Set(
        [...current].filter(
          (id) => availableIds.has(id) || (!listedIds.has(id) && !answeredFor(id))
        )
      )
      return next.size === current.size ? current : next
    })
  }, [repoList.state.status, repos, serverReposSettled, settledServerHosts])
}
