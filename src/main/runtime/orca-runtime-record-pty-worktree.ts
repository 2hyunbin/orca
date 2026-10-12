import type { PtyWorktreeRecordUpdate } from './terminal/identity/pty-worktree-record'
import { RuntimeWorkspaceQuerySurface } from './workspaces/workspace-query-surface'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

import type { RuntimeSyncedLeaf } from '../../shared/runtime-types'

export abstract class OrcaRuntimeWithRecordPtyWorktree extends RuntimeWorkspaceQuerySurface {
  protected recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    state: PtyWorktreeRecordUpdate = {}
  ): RuntimePtyWorktreeRecord {
    return this.terminalIdentity.recordPtyWorktree(ptyId, worktreeId, state)
  }

  protected makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string {
    return this.terminalIdentity.makeRuntimePaneKey(leaf)
  }

  protected getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null {
    return this.terminalIdentity.getOrCreatePtyWorktreeRecord(ptyId)
  }
}
