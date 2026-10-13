// A terminal tab saved only in another partition of its worktree (#18202) is not listed: the list
// shows the owner partition, as a window does. A close by handle or tab id still finds it there.
// Delete once main moves stranded rows into the owner partition at load.

import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'

/** The listed tabs plus the unlisted tab's rows from the partition holding it, for one close. */
export function withUnlistedTerminalTab(
  listed: RuntimeMobileSessionTabsSnapshot,
  tabId: string,
  holder: WorkspaceSessionState | null
): RuntimeMobileSessionTabsSnapshot {
  const holderWorktreeId = holder ? resolveTerminalSessionWorktreeId(holder, listed.worktree) : null
  const rows =
    holder && holderWorktreeId
      ? buildHeadlessMobileSessionTerminalTabs(
          listed.worktree,
          (holder.tabsByWorktree[holderWorktreeId] ?? []).filter((tab) => tab.id === tabId),
          holder
        )
      : []
  return rows.length > 0 ? { ...listed, tabs: [...listed.tabs, ...rows] } : listed
}
