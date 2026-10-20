import { useDesktopSidebarFeed, type DesktopSidebarFeed } from '@/lib/desktop-sidebar-feed'
import { useAppStore } from '@/store'
import type { SidebarListModelArgs } from './sidebar-list-model'

const NO_REPOS: SidebarListModelArgs['repos'] = []
const NO_PROJECT_GROUPS: SidebarListModelArgs['projectGroups'] = []

/**
 * Main's feed and the window's catalog, or neither. Main's rows can land before this window has its
 * saved view and project catalog, and the catalog before main's rows; either half alone draws rows
 * under default grouping and unnamed headers, or headers with no rows, then regroups.
 */
export function useStartupReadyFeed(args: Pick<SidebarListModelArgs, 'repos' | 'projectGroups'>): {
  feed: DesktopSidebarFeed | null
  repos: SidebarListModelArgs['repos']
  projectGroups: SidebarListModelArgs['projectGroups']
} {
  const catalogHydrated = useAppStore((s) => s.startupLocalCatalogHydrated)
  const installedFeed = useDesktopSidebarFeed()
  const ready = catalogHydrated && installedFeed !== null
  return {
    feed: ready ? installedFeed : null,
    repos: ready ? args.repos : NO_REPOS,
    projectGroups: ready ? args.projectGroups : NO_PROJECT_GROUPS
  }
}
