// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { parsePaneKey } from '../../shared/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import { OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding } from './orca-runtime-has-live-or-persisted-serve-or-ssh-owned-pty-binding'

export class OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal extends OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding {
  protected touchMobileSessionSnapshotsForPty(
    ptyId: string,
    options: { immediate?: boolean } = {}
  ): void {
    // A pane with no saved binding (a restored SSH pane) shows the terminal by its surface.
    const surface = this.ptysById.get(ptyId)
    const surfaceLeafId = parsePaneKey(surface?.paneKey ?? '')?.leafId
    const bySurface =
      surface?.tabId && surfaceLeafId ? { tabId: surface.tabId, leafId: surfaceLeafId } : null
    for (const worktreeId of this.sessionTabsWorktreeIdsBindingPty(ptyId, bySurface)) {
      this.touchMobileSessionTabsForWorktree(worktreeId, options)
    }
  }

  protected getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    return this.sessionTabsWorktreeIdsBindingPty(ptyId, null)
  }

  /** Read off the held model's terminal panes, so a lookup never projects every worktree. */
  protected sessionTabsWorktreeIdsBindingPty(
    ptyId: string,
    surface: { tabId: string; leafId: string } | null
  ): string[] {
    const models = new Map()
    const worktreeIds: string[] = []
    for (const worktreeId of this.sessionTabsStream.worktreeIds()) {
      const hostId = this.layoutHolder.hostIdOf(worktreeId)
      if (!hostId) {
        continue
      }
      if (!models.has(hostId)) {
        models.set(hostId, this.layoutHolder.model(hostId))
      }
      const workspace = models.get(hostId)?.workspaces[worktreeId]
      const leaves = workspace?.leaves ?? {}
      const shows = workspace?.tabs.some(
        (tab) =>
          tab.kind === 'terminal' &&
          collectLayoutLeafIdsInOrder(tab.panes.root).some(
            (leafId) =>
              leaves[leafId]?.ptyId === ptyId ||
              (tab.entityId === surface?.tabId && leafId === surface.leafId)
          )
      )
      if (shows && !this.isSavedUnderRemovedRepo(worktreeId)) {
        worktreeIds.push(worktreeId)
      }
    }
    return worktreeIds
  }
}
