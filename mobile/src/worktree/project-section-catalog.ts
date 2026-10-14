import type { AllHostProjectCatalog } from '../../../src/shared/all-host-project-catalog'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { getLogicalRepoOrderRankById } from '../../../src/shared/project-section-order'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import { NO_PROJECT_SECTION_CATALOG, type ProjectSectionCatalog } from './workspace-list-sections'

/**
 * Project grouping's inputs for the list: the whole catalog groups (as the desktop's index spans
 * every host), while only the shown hosts' repos can open an empty section.
 */
export function buildProjectSectionCatalog(
  catalog: AllHostProjectCatalog | null,
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  projectOrderBy: ProjectOrderBy
): ProjectSectionCatalog {
  if (!catalog) {
    return { ...NO_PROJECT_SECTION_CATALOG, projectOrderBy }
  }
  return {
    // Why: each host's repo.list is that host's persisted order, and the fold keeps the desktop's
    // load order (its own, then servers); the cross-host manualRepoOrder is pairing-local.
    repoOrder: getLogicalRepoOrderRankById(catalog.repos.map((repo) => repo.id)),
    repos: visibleHostIds
      ? catalog.repos.filter((repo) => visibleHostIds.has(getRepoExecutionHostId(repo)))
      : catalog.repos,
    grouping: catalog.grouping,
    projectOrderBy
  }
}
