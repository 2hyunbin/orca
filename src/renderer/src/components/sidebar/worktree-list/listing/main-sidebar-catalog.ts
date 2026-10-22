import type { ServedProjectSections } from '../../../../../../shared/project-section-catalog-schema'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoHostIdentity } from '../../../../../../shared/repo-host-identity'
import { buildSidebarFeedCatalog } from '../../../../../../shared/sidebar-list/sidebar-feed-catalog'
import type { SidebarFeedCatalog } from '../../../../../../shared/sidebar-list/sidebar-feed-rows'

/** The project catalog the main-built sidebar lists, and the repo lookup its rows render by. */
export type MainSidebarCatalog = SidebarFeedCatalog & { repoMap: Map<string, Repo> }

/**
 * Main's catalog (which projects and groups exist, their names, colours, membership and order),
 * with each repo's window details (kind, icon, settings) joined by host identity. A window repo
 * main does not list is never listed.
 */
export function joinMainSidebarCatalog(
  served: ServedProjectSections | null,
  windowRepos: readonly Repo[]
): MainSidebarCatalog {
  const catalog = buildSidebarFeedCatalog(served, [], [])
  const details = new Map(windowRepos.map((repo) => [getRepoHostIdentity(repo), repo]))
  const repos = catalog.repos.map((repo) => {
    const detail = details.get(getRepoHostIdentity(repo))
    return detail
      ? {
          ...detail,
          displayName: repo.displayName,
          path: repo.path,
          badgeColor: repo.badgeColor,
          projectGroupId: repo.projectGroupId,
          projectGroupOrder: repo.projectGroupOrder
        }
      : repo
  })
  return { ...catalog, repos, repoMap: new Map(repos.map((repo) => [repo.id, repo])) }
}
