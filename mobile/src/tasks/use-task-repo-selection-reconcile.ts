import { useEffect } from 'react'
import { isHostedTaskRepo, reconcileRepoSelection } from './hosted-repo-selection'
import type { useMobileTasksRouteAndItemState } from './use-mobile-tasks-route-and-item-state'

type RouteState = ReturnType<typeof useMobileTasksRouteAndItemState>

/**
 * Selection follows the list rather than the fetch, so it reconciles the same way no matter which
 * caller triggered the load.
 */
export function useTaskRepoSelectionReconcile(
  model: Pick<
    RouteState,
    | 'defaultRepoSelectionRef'
    | 'repoList'
    | 'repoSelectionHydratedRef'
    | 'repos'
    | 'serverReposSettled'
    | 'setSelectedRepoIds'
  >
): void {
  const {
    defaultRepoSelectionRef,
    repoList,
    repoSelectionHydratedRef,
    repos,
    serverReposSettled,
    setSelectedRepoIds
  } = model
  useEffect(() => {
    // Why settled: an id naming a server's repo is pending, not gone, until that server answers.
    if (repoList.state.status !== 'loaded' || !serverReposSettled) {
      return
    }
    if (!repoSelectionHydratedRef.current) {
      repoSelectionHydratedRef.current = true
      setSelectedRepoIds(reconcileRepoSelection(repos, defaultRepoSelectionRef.current))
      return
    }
    setSelectedRepoIds((current) => {
      if (current.size === 0) {
        return current
      }
      const availableIds = new Set(repos.filter(isHostedTaskRepo).map((repo) => repo.id))
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [repoList.state.status, repos, serverReposSettled])
}
