import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../orca-runtime-schedule-mobile-session-tabs-changed'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab } from '../orca-runtime-stored-mobile-snapshot-has-stale-preserved-tab'
import type { OrcaRuntimeWithResolveWorktreeRemovalTarget } from '../orca-runtime-resolve-worktree-removal-target'
import { OrcaRuntimeWithTerminalTitleRename } from '../terminal/output/terminal-title-rename'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeStore } from '../runtime-store-contract'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { runtimeWorktreeIdsEqual } from '../runtime-worktree-path-identity'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import { advertisedUrlWatcher } from '../../ports/advertised-url-watcher'
import { deleteWorktreeHistoryDir } from '../../terminal-history-deletion'
import { closeClientHostedBrowserPagesForWorktree } from '../worktree-browser-client-page-close'

export abstract class WorkspaceRemovalMetadata extends OrcaRuntimeWithTerminalTitleRename {
  protected abstract cancelScheduledMobileSessionTabsChanged(
    ...args: Parameters<
      OrcaRuntimeWithScheduleMobileSessionTabsChanged['cancelScheduledMobileSessionTabsChanged']
    >
  ): ReturnType<
    OrcaRuntimeWithScheduleMobileSessionTabsChanged['cancelScheduledMobileSessionTabsChanged']
  >
  protected abstract notifyMobileSessionTabsRemoved(
    ...args: Parameters<
      OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab['notifyMobileSessionTabsRemoved']
    >
  ): ReturnType<
    OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab['notifyMobileSessionTabsRemoved']
  >
  protected abstract closeHeadlessBrowserPagesForWorktree(
    ...args: Parameters<
      OrcaRuntimeWithResolveWorktreeRemovalTarget['closeHeadlessBrowserPagesForWorktree']
    >
  ): ReturnType<OrcaRuntimeWithResolveWorktreeRemovalTarget['closeHeadlessBrowserPagesForWorktree']>

  protected removeWorktreeMetadataAndHistory(
    store: RuntimeStore,
    worktreeId: string,
    hostId?: ExecutionHostId
  ): void {
    // Why: worktree IDs are path-derived and can be recreated, so removal must
    // purge history and process-local caches before the ID points at new state.
    const persistedHostId = store.getWorktreeMeta(worktreeId)?.hostId
    const repoId = splitWorktreeId(worktreeId)?.repoId
    const preservesSameIdOwner = Boolean(
      hostId &&
      ((persistedHostId && persistedHostId !== hostId) ||
        (repoId && hasWorktreeRemovalRepoOwnerOnOtherHost(store, repoId, hostId)))
    )
    const acceptedRendererSnapshot = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
    const storedSnapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (hostId) {
      store.removeWorktreeMeta(worktreeId, hostId)
    } else {
      store.removeWorktreeMeta(worktreeId)
    }
    // Why outside the same-id gate: retirement is per host and per pane, so a surviving owner keeps its own.
    this.dropAgentStatusForRemovedWorktreeFn?.(worktreeId, hostId ?? persistedHostId)
    if (!preservesSameIdOwner) {
      // A paired PTY can outlive the delete acknowledgement; it must not be
      // rescued into a newly-created occupant of the same path-derived ID.
      for (const ptyId of this.pairedRendererSessionOwnedPtyIds) {
        const ptyWorktreeId = this.ptysById.get(ptyId)?.worktreeId
        if (ptyWorktreeId && runtimeWorktreeIdsEqual(ptyWorktreeId, worktreeId)) {
          this.pairedRendererSessionOwnedPtyIds.delete(ptyId)
        }
      }
      const removedPublicationEpoch =
        acceptedRendererSnapshot?.publicationEpoch ??
        storedSnapshot?.publicationEpoch ??
        this.rendererGeneration ??
        undefined
      this.removedMobileSessionWorktreeIds.set(
        worktreeId,
        removedPublicationEpoch ? { removedPublicationEpoch } : {}
      )
      this.mobileSessionTabsByWorktree.delete(worktreeId)
      this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
      this.cancelScheduledMobileSessionTabsChanged(worktreeId)
      this.notifyMobileSessionTabsRemoved(worktreeId)
      advertisedUrlWatcher.forgetWorktree(worktreeId)
      deleteWorktreeHistoryDir(worktreeId)
      this.closeHeadlessBrowserPagesForWorktree(worktreeId)
      closeClientHostedBrowserPagesForWorktree(this, worktreeId)
    }
  }
}
