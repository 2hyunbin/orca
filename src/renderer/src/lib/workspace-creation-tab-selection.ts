import type { AppState } from '../store/types'
import { findWorkspaceCreationTab } from '../../../shared/workspace-creation-tab'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export function preferredWorkspaceViewerTab(
  tabs: readonly Tab[],
  terminals: readonly TerminalTab[],
  createdWithAgent: TuiAgent | undefined
): Tab | null {
  if (tabs.some((tab) => Number.isFinite(tab.lastFocusedAt))) {
    return null
  }
  const terminalAgents = new Map(terminals.map((tab) => [tab.id, tab.launchAgent]))
  return (
    findWorkspaceCreationTab(tabs, createdWithAgent, (tab) =>
      tab.contentType === 'agent-session'
        ? tab.agentSessionAgent
        : tab.contentType === 'terminal'
          ? terminalAgents.get(tab.entityId)
          : undefined
    ) ?? null
  )
}

export function selectWorkspaceCreationTab(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree' | 'activateTab'>,
  worktreeId: string,
  createdWithAgent: TuiAgent | undefined
): void {
  const tab = preferredWorkspaceViewerTab(
    state.unifiedTabsByWorktree[worktreeId] ?? [],
    state.tabsByWorktree[worktreeId] ?? [],
    createdWithAgent
  )
  if (tab) {
    // Derived display never creates new evidence of a viewer choice.
    state.activateTab(tab.id, { worktreeId, recordFocus: false })
  }
}
