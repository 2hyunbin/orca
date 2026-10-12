import type { RuntimeMobileSessionHydration } from './session-tabs/mobile-session-hydration'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './orca-runtime-collect-mobile-visible-graph-changed-worktrees'

export abstract class OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession extends OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees {
  protected hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    ...args: Parameters<
      RuntimeMobileSessionHydration['hydrateHeadlessMobileSessionTabsFromWorkspaceSession']
    >
  ): ReturnType<
    RuntimeMobileSessionHydration['hydrateHeadlessMobileSessionTabsFromWorkspaceSession']
  > {
    return this.runtimeMobileSessionHydration.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
      ...args
    )
  }
}
