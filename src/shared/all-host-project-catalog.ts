// Each host's catalog folded in the desktop renderer's load order: its own host, then servers.
import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'
import type { ProjectCatalogRows } from './project-compatibility-merge'
import { mergeFetchedHostProjectCatalog } from './project-compatibility-host-merge'
import { resolveProjectHostSetupProjection } from './project-host-setup-hydration'
import type { ProjectHostSetupProjection } from './project-host-setup-projection'
import type { ProjectGroupingModel } from './project-section-grouping'
import type { Repo } from './repo-types'

/** One host's repos and projection, already stamped with that host (see endpoint-catalog-adoption). */
export type HostProjectCatalog = {
  hostId: ExecutionHostId
  repos: readonly Repo[]
  projection: ProjectHostSetupProjection
}

export type AllHostProjectCatalog = {
  repos: readonly Repo[]
  grouping: ProjectGroupingModel
}

export function foldHostProjectCatalogs(
  catalogs: readonly HostProjectCatalog[]
): AllHostProjectCatalog {
  let repos: readonly Repo[] = []
  let rows: ProjectCatalogRows = { projects: [], projectHostSetups: [] }
  for (const catalog of catalogs) {
    repos = [
      ...repos.filter((repo) => getRepoExecutionHostId(repo) !== catalog.hostId),
      ...catalog.repos
    ]
    rows = mergeFetchedHostProjectCatalog({
      previous: rows,
      fetched: catalog.projection,
      repos,
      hostId: catalog.hostId
    })
  }
  const projection = resolveProjectHostSetupProjection(repos, rows.projects, rows.projectHostSetups)
  return {
    repos,
    grouping: { projects: projection.projects, projectHostSetups: projection.setups }
  }
}
