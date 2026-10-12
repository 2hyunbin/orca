import type { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from './orca-runtime-refresh-floating-workspace-pty-liveness'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from './orca-runtime-prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory } from './orca-runtime-refresh-pty-worktree-records-with-controller-inventory'
import { OrcaRuntimeWithRecordPtyWorktree } from './orca-runtime-record-pty-worktree'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export abstract class OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController extends OrcaRuntimeWithRecordPtyWorktree {
  protected abstract refreshFloatingWorkspacePtyLiveness(
    ...args: Parameters<
      OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness['refreshFloatingWorkspacePtyLiveness']
    >
  ): ReturnType<
    OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness['refreshFloatingWorkspacePtyLiveness']
  >

  protected abstract getMobileTerminalPaneKey(
    ...args: Parameters<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['getMobileTerminalPaneKey']>
  ): ReturnType<OrcaRuntimeWithPruneMobileSessionTabGroupLayout['getMobileTerminalPaneKey']>
  protected abstract refreshPtyWorktreeRecordsWithControllerInventory(
    ...args: Parameters<
      OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory['refreshPtyWorktreeRecordsWithControllerInventory']
    >
  ): ReturnType<
    OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory['refreshPtyWorktreeRecordsWithControllerInventory']
  >

  /** Synchronizes PTY tracking records with running daemon sessions, querying their foreground agent states. */
  protected async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
    return inventory ? new Set(inventory.livePtyIds) : null
  }
}
