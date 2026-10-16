import { removedOwnerTabIds } from './worktree-removal-owner'
import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  captureWorkspaceChatDraftKeys,
  type WorkspaceChatDraftKeys
} from './removed-worktree-chat-drafts'

/** What the teardown needs from the worktree's tab lists, which a listing refresh started during
 *  the removal round trip can drop before the teardown runs. */
export type WorktreeStateBeforeRemoval = {
  readonly tabIds: ReadonlySet<string>
  readonly terminalPtyIds: readonly string[]
  readonly chatDraftKeys: WorkspaceChatDraftKeys
}

export function captureWorktreeStateBeforeRemoval(
  state: Pick<
    AppState,
    'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId' | 'worktreesByRepo'
  >,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): WorktreeStateBeforeRemoval {
  const tabIds = removedOwnerTabIds(state, worktreeId, executionHostId)
  return {
    tabIds,
    terminalPtyIds: (state.tabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tabIds.has(tab.id))
      .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? []),
    chatDraftKeys: captureWorkspaceChatDraftKeys(state, [
      { workspaceId: worktreeId, executionHostId }
    ])
  }
}
