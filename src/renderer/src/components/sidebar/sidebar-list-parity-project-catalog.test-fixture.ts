import type { AppState } from '@/store/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getManualRepoOrder } from '../../../../shared/manual-repo-order'
import {
  buildSidebarProjectCatalog,
  type PairedServerCatalog
} from '../../../../shared/sidebar-list/sidebar-project-catalog'

const SERVER_HOST_ID = 'runtime:env-1'

const isServerHost = (hostId: string | null | undefined): boolean =>
  parseExecutionHostId(hostId)?.kind === 'runtime'

/**
 * The window's catalog split as main holds it: this host's own rows, and what the paired server's
 * own reads answer. The manual order is the one the window saved for its header order.
 */
export function projectCatalogFromWindowState(state: AppState) {
  const own = <T extends { executionHostId?: string | null }>(rows: readonly T[]): T[] =>
    rows.filter((row) => !isServerHost(row.executionHostId))
  const server: PairedServerCatalog = {
    hostId: SERVER_HOST_ID,
    repos: state.repos.filter((repo) => getRepoExecutionHostId(repo) === SERVER_HOST_ID),
    projectGroups: (state.projectGroups ?? []).filter(
      (projectGroup) => projectGroup.executionHostId === SERVER_HOST_ID
    ),
    projection: {
      projects: state.projects,
      setups: state.projectHostSetups.filter((setup) => setup.hostId === SERVER_HOST_ID)
    }
  }
  return buildSidebarProjectCatalog(
    {
      repos: own(state.repos),
      projectGroups: own(state.projectGroups ?? []),
      projects: state.projects,
      setups: state.projectHostSetups.filter((setup) => !isServerHost(setup.hostId))
    },
    [server],
    { manualRepoOrder: getManualRepoOrder(state.repos), projectOrderBy: state.projectOrderBy }
  )
}
