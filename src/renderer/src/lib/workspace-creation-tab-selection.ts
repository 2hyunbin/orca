import { useAppStore } from '@/store'
import { findWorkspaceCreationTab } from '../../../shared/workspace-creation-tab'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Selects the tab the workspace was created for, when it is already in this window. */
export function selectWorkspaceCreationTab(
  worktreeId: string,
  createdWithAgent: TuiAgent | undefined
): void {
  const state = useAppStore.getState()
  const terminalAgents = new Map(
    (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab.launchAgent])
  )
  const tab = findWorkspaceCreationTab(
    state.unifiedTabsByWorktree[worktreeId] ?? [],
    createdWithAgent,
    (candidate) =>
      candidate.contentType === 'agent-session'
        ? candidate.agentSessionAgent
        : candidate.contentType === 'terminal'
          ? terminalAgents.get(candidate.entityId)
          : undefined
  )
  if (tab) {
    // Not the user's focus: the create chose this tab, so the focus-time stamp stays untouched.
    state.activateTab(tab.id, { worktreeId, recordFocus: false })
  }
}
