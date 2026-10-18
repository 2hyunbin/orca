import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { Repo } from '../../../src/shared/repo-types'
import type {
  SidebarFeedCatalog,
  SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import type { MobileViewState } from '../worktree/workspace-view-settings'
import type { SectionRepo } from '../worktree/workspace-list-types'

/** Which host the desktop has focused and what it calls its hosts (settings.get). */
export type DesktopHostFocus = {
  focusedHostId: ExecutionHostId
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string>
}

export const INITIAL_DESKTOP_HOST_FOCUS: DesktopHostFocus = {
  focusedHostId: LOCAL_EXECUTION_HOST_ID,
  hostLabelOverrides: new Map()
}

/**
 * The view the desktop's sidebar shows, from the shared UI state and settings this phone mirrors.
 * The host list is passed resolved with an "all" scope, which every builder step reads the same
 * as the desktop's legacy scope.
 */
export function buildHostFeedView(args: {
  view: MobileViewState
  projectOrderBy: ProjectOrderBy
  showPinnedInGroups: boolean
  desktop: DesktopHostFocus
  /** The desktop's platform names its own host; the phone's must never. */
  hostPlatform: NodeJS.Platform | null
}): SidebarFeedView {
  const { view, desktop, hostPlatform } = args
  const hostLabelOverrides = new Map(desktop.hostLabelOverrides)
  if (hostPlatform && !hostLabelOverrides.has(LOCAL_EXECUTION_HOST_ID)) {
    hostLabelOverrides.set(LOCAL_EXECUTION_HOST_ID, getLocalExecutionHostLabel(hostPlatform))
  }
  return {
    groupBy: view.groupBy,
    sortBy: view.sortBy,
    projectOrderBy: args.projectOrderBy,
    collapsedGroups: new Set(view.collapsedGroups),
    filters: view.filters,
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: view.filters.visibleHostIds,
    workspaceStatuses: view.workspaceStatuses,
    pinnedDisplayPolicy: args.showPinnedInGroups ? 'duplicate-in-groups' : 'single-location',
    defaultHostId: desktop.focusedHostId,
    hostLabelOverrides
  }
}

function catalogRepo(repo: SectionRepo): Repo {
  return {
    id: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    badgeColor: repo.badgeColor ?? '',
    addedAt: repo.addedAt ?? 0,
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId ? { executionHostId: repo.executionHostId } : {})
  }
}

/**
 * The catalog the feed does not carry: the one the desktop window publishes (every host, paired
 * servers included), or on a host with no window its own repos and project groups.
 */
export function buildHostFeedCatalog(
  served: ServedProjectSections | null,
  hostRepos: readonly SectionRepo[],
  hostProjectGroups: readonly ProjectGroup[]
): SidebarFeedCatalog {
  return served
    ? {
        repos: served.repos.map(catalogRepo),
        projectGroups: served.projectGroups ?? hostProjectGroups,
        projectGrouping: { projects: served.projects, projectHostSetups: served.setups }
      }
    : {
        repos: hostRepos.map(catalogRepo),
        projectGroups: hostProjectGroups,
        projectGrouping: { projects: [], projectHostSetups: [] }
      }
}
