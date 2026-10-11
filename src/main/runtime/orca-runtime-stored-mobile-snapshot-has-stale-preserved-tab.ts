// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeMobileSessionPreservation } from './session-tabs/mobile-session-preservation'
import { OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs } from './orca-runtime-merge-preserved-headless-mobile-session-tabs'
import type { RuntimeMobileSessionTabsRemovedResult } from '../../shared/runtime-types'

import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'

export class OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab extends OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs {
  // Why: the accepted-revision no-op gate must not fossilize preserved runtime
  // tabs. A stored merged snapshot's tabs absent from the accepted renderer
  // publication exist only via preservation; if any such tab no longer
  // passes the preservation predicate (binding removed from the live PTY table
  // and persisted session, or browser page closed), the stored snapshot is stale.
  protected storedMobileSnapshotHasStalePreservedTab(
    ...args: Parameters<
      RuntimeMobileSessionPreservation['storedMobileSnapshotHasStalePreservedTab']
    >
  ): ReturnType<RuntimeMobileSessionPreservation['storedMobileSnapshotHasStalePreservedTab']> {
    return this.runtimeMobileSessionPreservation.storedMobileSnapshotHasStalePreservedTab(...args)
  }

  protected isHeadlessMobileSessionPublication(
    ...args: Parameters<RuntimeMobileSessionPreservation['isHeadlessMobileSessionPublication']>
  ): ReturnType<RuntimeMobileSessionPreservation['isHeadlessMobileSessionPublication']> {
    return this.runtimeMobileSessionPreservation.isHeadlessMobileSessionPublication(...args)
  }

  // Why: `:headless-merge:` only marks that runtime tabs were merged in — the
  // BASE epoch still says who published the snapshot. A renderer-based merged
  // snapshot must not be classified as headless-built, or its renderer tabs
  // read as runtime-owned.
  protected isHeadlessBuiltMobileSessionPublicationBase(
    ...args: Parameters<
      RuntimeMobileSessionPreservation['isHeadlessBuiltMobileSessionPublicationBase']
    >
  ): ReturnType<RuntimeMobileSessionPreservation['isHeadlessBuiltMobileSessionPublicationBase']> {
    return this.runtimeMobileSessionPreservation.isHeadlessBuiltMobileSessionPublicationBase(
      ...args
    )
  }

  protected getMergedMobileSessionPublicationEpoch(
    ...args: Parameters<RuntimeMobileSessionPreservation['getMergedMobileSessionPublicationEpoch']>
  ): ReturnType<RuntimeMobileSessionPreservation['getMergedMobileSessionPublicationEpoch']> {
    return this.runtimeMobileSessionPreservation.getMergedMobileSessionPublicationEpoch(...args)
  }

  /** Serves a hydrating host renderer; the publisher counts this as a delivery, not a read. */
  listClientHostedBrowserRows(): ClientHostedBrowserRowsEvent[] {
    return this.clientHostedBrowserRows.deliverHydrationSnapshot()
  }

  protected notifyMobileSessionTabsRemoved(worktreeId: string): void {
    const removed: RuntimeMobileSessionTabsRemovedResult = {
      worktree: worktreeId,
      publicationEpoch: `removed:${Date.now().toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.clientSessionTabSelections.project(removed, subscription.clientNavigationId),
        changeSequence
      )
    }
    this.clientSessionTabSelections.forgetWorktree(worktreeId)
  }

  notifyMobileSessionTabsChanged(worktreeId?: string): void {
    if (!worktreeId) {
      this.clientHostedBrowserRows.publishAll()
      for (const id of new Set([
        ...this.persistedClientHostedBrowserWorktreeIds,
        ...getRuntimeBrowserPageRegistry(this)
          .listPages()
          .map((page) => page.workspaceId)
      ])) {
        this.persistClientHostedBrowserPagesForWorktree(id)
      }
      this.notifyMobileSessionTabSnapshots()
      return
    }
    // Why: every client-page mutation — create, navigate, metadata, host quit, recovery — reaches
    // this announcement, so the host's own rows derive from it rather than from a second seam.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const hasClientBrowserPages =
      getRuntimeBrowserPageRegistry(this).listPages(worktreeId).length > 0
    if (this.offscreenBrowserBackend || hasClientBrowserPages) {
      const reconciled = this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId,
        hasClientBrowserPages
          ? { allowAttachedWindow: true, onlyRuntimeOwnedTerminals: true }
          : undefined
      )
      // Why: hydrate already reconciles an existing snapshot in place; only reconcile here when it didn't (fresh build or early-returned hydrate).
      if (!reconciled.has(worktreeId)) {
        const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
        if (existing) {
          this.reconcileHeadlessMobileSessionBrowserTabs(worktreeId, existing)
        }
      }
    }
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
  }

  protected collectPreservedHeadlessMobileSessionTabs(
    ...args: Parameters<
      RuntimeMobileSessionPreservation['collectPreservedHeadlessMobileSessionTabs']
    >
  ): ReturnType<RuntimeMobileSessionPreservation['collectPreservedHeadlessMobileSessionTabs']> {
    return this.runtimeMobileSessionPreservation.collectPreservedHeadlessMobileSessionTabs(...args)
  }

  protected shouldPreserveHeadlessMobileSessionTab(
    ...args: Parameters<RuntimeMobileSessionPreservation['shouldPreserveHeadlessMobileSessionTab']>
  ): ReturnType<RuntimeMobileSessionPreservation['shouldPreserveHeadlessMobileSessionTab']> {
    return this.runtimeMobileSessionPreservation.shouldPreserveHeadlessMobileSessionTab(...args)
  }
}
