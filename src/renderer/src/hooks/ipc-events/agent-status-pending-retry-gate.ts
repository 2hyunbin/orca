import type { AppState } from '../../store/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { selectRepos } from '@/store/project-catalog-selectors'

type AgentStatusPendingRetryState = Pick<
  AppState,
  | 'workspaceSessionReady'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'worktreesByRepo'
  | 'repos'
  | 'recentlyClosedAgentStatusTabIds'
  | 'recentlyRetiredAgentStatusPaneKeys'
>

export function shouldRetryPendingAgentStatusesAfterStoreUpdate(
  current: AgentStatusPendingRetryState,
  previous: AgentStatusPendingRetryState
): boolean {
  return (
    current.workspaceSessionReady !== previous.workspaceSessionReady ||
    current.tabsByWorktree !== previous.tabsByWorktree ||
    current.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
    current.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId ||
    selectWorktreesByRepo(current) !== selectWorktreesByRepo(previous) ||
    selectRepos(current) !== selectRepos(previous) ||
    current.recentlyClosedAgentStatusTabIds !== previous.recentlyClosedAgentStatusTabIds ||
    current.recentlyRetiredAgentStatusPaneKeys !== previous.recentlyRetiredAgentStatusPaneKeys
  )
}
