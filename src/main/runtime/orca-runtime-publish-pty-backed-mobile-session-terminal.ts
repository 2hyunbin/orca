// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { parsePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding } from './orca-runtime-has-live-or-persisted-serve-or-ssh-owned-pty-binding'

export class OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal extends OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding {
  protected touchMobileSessionSnapshotsForPty(
    ptyId: string,
    options: { immediate?: boolean } = {}
  ): void {
    // A pane with no saved binding (a restored SSH pane) shows the terminal by its surface.
    const surface = this.ptysById.get(ptyId)
    const surfaceLeafId = parsePaneKey(surface?.paneKey ?? '')?.leafId
    for (const [worktreeId, snapshot] of this.sessionTabsSnapshots()) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId ||
            tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId ||
            (tab.parentTabId === surface?.tabId && tab.leafId === surfaceLeafId))
      )
      if (!hasPtyBackedTab) {
        continue
      }
      this.touchMobileSessionTabsForWorktree(worktreeId, options)
    }
  }

  protected getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    const worktreeIds: string[] = []
    for (const [worktreeId, snapshot] of this.sessionTabsSnapshots()) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (hasPtyBackedTab) {
        worktreeIds.push(worktreeId)
      }
    }
    return worktreeIds
  }
}
