import type { mergeStructuredAgentSessionTabGroups } from './structured-session-tab-groups'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  BrowserTabInfo
} from '../../../shared/runtime-types'
import {
  getMobileSessionSnapshotTabIdentityKeys,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../mobile-session-tab-merge'
import { terminalLayoutContainsLeaf } from '../../../shared/workspace-session-pane-ownership'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'
import { sameRuntimeBrowserPlacement } from '../../../shared/runtime-browser-placement'
import type { RuntimeBrowserClientPage } from '../runtime-browser-page-registry'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type RuntimeMobileSessionPreservationHost = {
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null
  isMobileTerminalCreatePending(key: string): boolean
  hasLiveRuntimeSessionOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean
  hasLiveOrPersistedServeOrSshOwnedPtyBinding(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean
  clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string
  ): void
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  setPairedRendererSessionOwnership(ptyId: string, owned: boolean): void
  getClientBrowserPage(browserPageId: string): RuntimeBrowserClientPage | undefined
  hasOffscreenBrowserBackend(): boolean
  getLiveBrowserTabsByPageId(worktreeId: string): ReadonlyMap<string, BrowserTabInfo>
  collectPreservedHeadlessMobileSessionTabs: RuntimeMobileSessionPreservation['collectPreservedHeadlessMobileSessionTabs']
  getMergedMobileSessionPublicationEpoch: RuntimeMobileSessionPreservation['getMergedMobileSessionPublicationEpoch']
  mergeStructuredAgentSessionTabGroups: typeof mergeStructuredAgentSessionTabGroups
  isHeadlessBuiltMobileSessionPublicationBase: RuntimeMobileSessionPreservation['isHeadlessBuiltMobileSessionPublicationBase']
  shouldPreserveHeadlessMobileSessionTab: RuntimeMobileSessionPreservation['shouldPreserveHeadlessMobileSessionTab']
}

export class RuntimeMobileSessionPreservation {
  constructor(private readonly host: RuntimeMobileSessionPreservationHost) {}

  mergePreservedHeadlessMobileSessionTabs(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    if (!existing) {
      return snapshot
    }
    const preservedTabs = this.host.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return snapshot
    }
    const preservedActiveTab = preservedTabs.find(
      (tab) => tab.id === existing.activeTabId && tab.isActive
    )
    const hasIncomingActiveTab = snapshot.tabs.some((tab) => tab.isActive)
    const normalizedPreservedTabs = preservedTabs.map((tab) =>
      hasIncomingActiveTab && !preservedActiveTab ? { ...tab, isActive: false } : tab
    )
    const normalizedIncomingTabs = preservedActiveTab
      ? snapshot.tabs.map((tab) => (tab.isActive ? { ...tab, isActive: false } : tab))
      : snapshot.tabs
    const tabs = mergeMobileSessionSnapshotTabs(normalizedIncomingTabs, normalizedPreservedTabs)
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    const activeTab =
      preservedActiveTab ??
      normalizedIncomingTabs.find((tab) => tab.id === snapshot.activeTabId) ??
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    const tabGroups = mergeMobileSessionTabGroups(
      snapshot.worktree,
      snapshot.tabGroups ?? existing.tabGroups ?? [],
      terminalTabs,
      activeTab?.type === 'terminal' ? activeTab : null
    )
    return {
      ...snapshot,
      publicationEpoch: this.host.getMergedMobileSessionPublicationEpoch(
        snapshot,
        normalizedPreservedTabs
      ),
      snapshotVersion: Math.max(snapshot.snapshotVersion, existing.snapshotVersion),
      activeGroupId: snapshot.activeGroupId ?? existing.activeGroupId,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: this.host.mergeStructuredAgentSessionTabGroups(
        tabGroups,
        existing.tabGroups ?? [],
        normalizedPreservedTabs,
        activeTab?.id ?? null
      ),
      tabs
    }
  }

  releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): void {
    if (
      !existing ||
      this.host.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
    ) {
      return
    }
    const session = this.host.getWorkspaceSessionForWorktree(existing.worktree)
    const persistedTabs = session?.tabsByWorktree?.[existing.worktree]
    if (!session || !persistedTabs) {
      return
    }
    const persistedTabsById = new Map(persistedTabs.map((tab) => [tab.id, tab]))
    const incomingIds = new Set(
      incoming.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
    )
    for (const tab of existing.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.host.isMobileTerminalCreatePending(`${existing.worktree}::${tab.parentTabId}`) ||
        getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))
      ) {
        continue
      }
      if (!this.host.hasLiveRuntimeSessionOwnedPtyBinding(existing.worktree, tab)) {
        continue
      }
      const persistedParent = persistedTabsById.get(tab.parentTabId)
      if (!persistedParent) {
        this.host.clearRuntimeSessionOwnershipForMobileTab(
          existing.worktree,
          existing,
          tab.parentTabId
        )
        continue
      }
      const layout = session.terminalLayoutsByTabId?.[tab.parentTabId]
      const boundPtyIds = [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
        (id): id is string => typeof id === 'string'
      )
      const persistedIds = new Set(
        [persistedParent.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].filter(
          (id): id is string => typeof id === 'string'
        )
      )
      if (
        layout &&
        !layout.ptyIdsByLeafId?.[tab.leafId] &&
        !terminalLayoutContainsLeaf(layout.root, tab.leafId) &&
        !boundPtyIds.some((id) => persistedIds.has(id))
      ) {
        for (const ptyId of boundPtyIds) {
          const pty = this.host.getPty(ptyId)
          if (pty?.worktreeId === existing.worktree && pty.tabId === tab.parentTabId) {
            pty.runtimeSessionOwned = false
            this.host.setPairedRendererSessionOwnership(ptyId, false)
          }
        }
      }
    }
  }

  buildPreservedHeadlessMobileSessionSnapshot(
    existing: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot | null {
    const tabs = this.host.collectPreservedHeadlessMobileSessionTabs(existing)
    if (tabs.length === 0) {
      return null
    }
    const activeTab =
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    return {
      ...existing,
      publicationEpoch: this.host.getMergedMobileSessionPublicationEpoch(existing, tabs),
      // Why: mint a fresh version or clients' same-epoch gate drops the prune frame.
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId: existing.activeGroupId ?? getHeadlessMobileSessionGroupId(existing.worktree),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: mergeMobileSessionTabGroups(
        existing.worktree,
        existing.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      tabs
    }
  }

  storedMobileSnapshotHasStalePreservedTab(
    existing: RuntimeMobileSessionTabsSnapshot,
    rendererTabIdentityKeys: ReadonlySet<string>
  ): boolean {
    return existing.tabs.some(
      (tab) =>
        !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
          rendererTabIdentityKeys.has(id)
        ) && !this.host.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    )
  }

  collectPreservedHeadlessMobileSessionTabs(
    existing: RuntimeMobileSessionTabsSnapshot,
    incoming?: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionSnapshotTab[] {
    const incomingIds = new Set(
      incoming?.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab)) ?? []
    )
    return existing.tabs.filter((tab) => {
      if (getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))) {
        return false
      }
      return this.host.shouldPreserveHeadlessMobileSessionTab(existing, tab)
    })
  }

  shouldPreserveHeadlessMobileSessionTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionSnapshotTab
  ): boolean {
    if (tab.type === 'agent-session') {
      return true
    }
    if (tab.type === 'browser') {
      const liveClientPage =
        typeof tab.browserPageId === 'string'
          ? this.host.getClientBrowserPage(tab.browserPageId)
          : undefined
      if (
        liveClientPage?.workspaceId === snapshot.worktree &&
        tab.placement?.kind === 'client' &&
        sameRuntimeBrowserPlacement(liveClientPage.placement, tab.placement)
      ) {
        return true
      }
      // Why: headless offscreen browser tabs exist only server-side, so a renderer-graph merge must keep them, not prune as "not in the graph".
      if (!this.host.hasOffscreenBrowserBackend()) {
        return false
      }
      // Why: in a renderer-based merged snapshot the browser entries can also
      // be renderer-owned, so only pages the offscreen bridge still lists are
      // runtime-owned and preservable; a pure renderer epoch preserves none.
      return (
        this.host.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
        (snapshot.publicationEpoch.includes(':headless-merge:') &&
          typeof tab.browserPageId === 'string' &&
          this.host.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId))
      )
    }
    if (tab.type !== 'terminal') {
      return false
    }
    if (this.host.isMobileTerminalCreatePending(`${snapshot.worktree}::${tab.parentTabId}`)) {
      return true
    }
    // Why: a merged renderer snapshot carries BOTH renderer-owned and
    // runtime-owned tabs, so the epoch alone must not preserve every terminal —
    // that resurrects renderer tabs the renderer already closed. Broad
    // preservation applies only to genuinely headless-built snapshots; in a
    // renderer-based one, only tabs with a live-or-persisted serve/SSH binding
    // are runtime-owned and preservable.
    return (
      this.host.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch) ||
      this.host.hasLiveRuntimeSessionOwnedPtyBinding(snapshot.worktree, tab) ||
      this.host.hasLiveOrPersistedServeOrSshOwnedPtyBinding(snapshot.worktree, tab)
    )
  }

  isHeadlessMobileSessionPublication(publicationEpoch: string): boolean {
    return (
      publicationEpoch.startsWith('headless:') ||
      publicationEpoch.startsWith('headless-hydrated:') ||
      publicationEpoch.includes(':headless-merge:')
    )
  }

  isHeadlessBuiltMobileSessionPublicationBase(publicationEpoch: string): boolean {
    const base = publicationEpoch.split(':headless-merge:')[0]
    return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
  }

  getMergedMobileSessionPublicationEpoch(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    _preservedTabs: readonly RuntimeMobileSessionSnapshotTab[]
  ): string {
    // Why: preserved snapshots can merge repeatedly; strip the prior merge suffix first so the publication epoch stays idempotent.
    const normalizedPublicationEpoch = snapshot.publicationEpoch.split(':headless-merge:')[0]
    // The epoch identifies the publisher generation, not the merged content.
    // Content changes are ordered by snapshotVersion, so encoding a merge hash
    // here would make the identity oscillate and permanently fence later rows.
    return normalizedPublicationEpoch
  }
}
