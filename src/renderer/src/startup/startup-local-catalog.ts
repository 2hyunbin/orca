import { useAppStore } from '../store'
import type { StartupActions } from '../app-shell/startup-actions-selector'
import { timeRendererStartupStep } from './startup-diagnostics'

/** This host's project groups, then its folder workspaces (they merge against the groups). */
export async function hydrateStartupLocalCatalog(
  actions: Pick<
    StartupActions,
    'fetchProjectGroupsForAllHosts' | 'fetchFolderWorkspacesForAllHosts'
  >,
  isCancelled: () => boolean
): Promise<void> {
  await timeRendererStartupStep('fetch-project-groups-local', () =>
    actions.fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
  )
  await timeRendererStartupStep('fetch-folder-workspaces-local', () =>
    actions.fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
  )
  // Repos and the saved view hydrated before this chain began; the sidebar may now draw.
  if (!isCancelled()) {
    useAppStore.setState({ startupLocalCatalogHydrated: true })
  }
}
