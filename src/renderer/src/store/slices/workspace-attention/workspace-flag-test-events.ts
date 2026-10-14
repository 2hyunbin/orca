import type { AppState } from '../../types'

type AttentionStoreHandle = {
  getState: () => Pick<AppState, 'markAgentAttentionUnread' | 'readTerminalPaneOnInput'>
}

/** A workspace-only agent completion: lights the workspace flag and no marker. */
export function markWorkspaceUnread(store: AttentionStoreHandle, worktreeId: string): void {
  store.getState().markAgentAttentionUnread({
    workspaceId: worktreeId,
    subjectKey: null,
    groupId: null,
    reason: 'agent-completion',
    groupAttentionEnabled: false
  })
}

/** Input in a tab holding no marker: reads the workspace flag and nothing else. */
export function readWorkspace(store: AttentionStoreHandle, worktreeId: string): void {
  store.getState().readTerminalPaneOnInput({ worktreeId, tabId: 'no-marked-tab', paneKey: null })
}
