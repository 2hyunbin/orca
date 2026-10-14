import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { getLogicalRepoOrderRankById } from '../../../src/shared/project-section-order'
import type { ServedProjectSections } from './project-sections-operations'
import { NO_PROJECT_SECTION_CATALOG, type ProjectSectionCatalog } from './workspace-list-sections'
import type { SectionRepo } from './workspace-list-types'

/**
 * Project grouping's inputs: the desktop sidebar's own catalog when it serves one, else (an older
 * desktop) its own repos with no projects, so rows group by repo. Only shown hosts' repos open
 * empty sections; the grouping itself spans every host, as the desktop's does.
 */
export function buildProjectSectionCatalog(
  served: ServedProjectSections | null,
  desktopRepos: readonly SectionRepo[],
  visibleHostIds: ReadonlySet<ExecutionHostId> | null
): ProjectSectionCatalog {
  const shown = (repos: readonly SectionRepo[]) =>
    visibleHostIds
      ? repos.filter((repo) => visibleHostIds.has(getRepoExecutionHostId(repo)))
      : repos
  if (!served) {
    return { ...NO_PROJECT_SECTION_CATALOG, repos: shown(desktopRepos) }
  }
  return {
    repos: shown(served.repos),
    grouping: { projects: served.projects, projectHostSetups: served.setups },
    // Why: served repos come in the sidebar's header order, cross-host manual order included.
    repoOrder: getLogicalRepoOrderRankById(served.repos.map((repo) => repo.id)),
    projectOrderBy: served.projectOrderBy
  }
}
