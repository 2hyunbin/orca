// Layout-owner build: restore never reattaches a pane to a terminal another workspace owns
// (the window's rule, deferred-session-reattach-choice.ts); such a pane starts fresh instead.

import { isPtySessionIdOwnedByWorktree } from '../../../../shared/pty-session-id-format'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

export type PaneBinding = { worktreeId: string; tabId: string; leafId: string; ptyId: string }

/** Every pane `session` binds to a terminal minted for another workspace. */
export function panesBoundToAnotherWorkspace(session: WorkspaceSessionState): PaneBinding[] {
  return Object.entries(session.tabsByWorktree ?? {}).flatMap(([worktreeId, rows]) =>
    rows.flatMap((row) =>
      Object.entries(session.terminalLayoutsByTabId?.[row.id]?.ptyIdsByLeafId ?? {}).flatMap(
        ([leafId, ptyId]) =>
          ptyId && !isRemoteRuntimePtyId(ptyId) && !isPtySessionIdOwnedByWorktree(ptyId, worktreeId)
            ? [{ worktreeId, tabId: row.id, leafId, ptyId }]
            : []
      )
    )
  )
}
