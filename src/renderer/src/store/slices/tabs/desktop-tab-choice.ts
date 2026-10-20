import type { AppState } from '../../types'
import type { Tab } from '../../../../../shared/tab-types'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  resolveWorkspaceViewerTab,
  SESSION_TAB_IDENTITY
} from '../../../../../shared/workspace-creation-tab'
import { findWorktreeById } from '../worktree-helpers'

/**
 * This window's own tab choices, the desktop half of `resolveWorkspaceViewerTab`: a workspace is
 * listed once its user clicks, keys to, opens or creates one of its tabs, or restores a saved
 * selection. Automatic creates (seed, Setup, default tabs, adopted PTYs, host-published creation
 * surfaces) never list it; until then its shown tab is a derived default, never saved as a choice.
 */
export type DesktopTabChoices = Readonly<Record<string, true>>

type ChoiceState = Partial<
  Pick<AppState, 'desktopTabChoices' | 'worktreesByRepo' | 'folderWorkspaces' | 'tabsByWorktree'>
>

/** The agent a workspace was created with, while this window has chosen none of its tabs. */
export function unchosenCreationAgent(state: ChoiceState, worktreeId: string): string | undefined {
  if (!state.desktopTabChoices || state.desktopTabChoices[worktreeId]) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? state.folderWorkspaces?.find((folder) => folder.id === scope.folderWorkspaceId)
        ?.createdWithAgent
    : findWorktreeById(state.worktreesByRepo ?? {}, worktreeId)?.createdWithAgent
}

/** The tab an unchosen workspace shows by default, among `tabs` in tab order. */
export function desktopCreationDefaultTab(
  state: ChoiceState,
  worktreeId: string,
  tabs: readonly Tab[]
): Tab | undefined {
  const createdWithAgent = unchosenCreationAgent(state, worktreeId)
  if (!createdWithAgent) {
    return undefined
  }
  const terminals = state.tabsByWorktree?.[worktreeId] ?? []
  return resolveWorkspaceViewerTab(
    tabs,
    { chosenTabId: null, createdWithAgent },
    {
      idOf: (tab) => tab.id,
      agentOf: (tab) =>
        tab.contentType === 'terminal'
          ? terminals.find((terminal) => terminal.id === tab.entityId)?.launchAgent
          : tab.agentSessionAgent
    }
  )
}

/** A host snapshot's creation chat that this window has not shown yet: it arrives as the default. */
export function arrivingCreationChat(
  state: ChoiceState & Pick<AppState, 'unifiedTabsByWorktree'>,
  worktreeId: string,
  snapshot: { tabs: readonly RuntimeMobileSessionClientTab[] }
): RuntimeMobileSessionClientTab | null {
  const createdWithAgent = unchosenCreationAgent(state, worktreeId)
  const tab = createdWithAgent
    ? resolveWorkspaceViewerTab(
        snapshot.tabs,
        { chosenTabId: null, createdWithAgent },
        SESSION_TAB_IDENTITY
      )
    : undefined
  if (tab?.type !== 'agent-session') {
    return null
  }
  const shown = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
    (local) => local.contentType === 'agent-session' && local.entityId === tab.sessionId
  )
  return shown ? null : tab
}

/** Saved selections are choices; a workspace saved without one stays unchosen. */
export function hydratedDesktopTabChoices(
  tabGroups: Readonly<Record<string, readonly { activeTabId: string | null }[]>> | undefined
): DesktopTabChoices {
  return Object.fromEntries(
    Object.entries(tabGroups ?? {}).flatMap(([worktreeId, groups]) =>
      groups.some((group) => group.activeTabId) ? [[worktreeId, true] as const] : []
    )
  )
}
