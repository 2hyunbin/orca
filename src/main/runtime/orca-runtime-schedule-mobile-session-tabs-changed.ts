// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from './orca-runtime-write-orchestration-pointer-pty'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'

export class OrcaRuntimeWithScheduleMobileSessionTabsChanged extends OrcaRuntimeWithWriteOrchestrationPointerPty {
  /** The phone list is a projection of the holder's model, built on read and never stored. */
  protected readSessionTabsSnapshot(
    worktreeId: string
  ): RuntimeMobileSessionTabsSnapshot | undefined {
    const snapshot = this.sessionTabsStream.snapshot(worktreeId)
    if (!snapshot || this.isSavedUnderRemovedRepo(worktreeId)) {
      return undefined
    }
    // Pages the runtime hosts or brokers carry their live placement and state.
    const pages = new Map(
      this.buildHeadlessMobileSessionBrowserTabs(worktreeId).map((page) => [
        page.browserPageId,
        page
      ])
    )
    const tabs = snapshot.tabs.map((tab) => {
      const page = tab.type === 'browser' && tab.browserPageId ? pages.get(tab.browserPageId) : null
      if (!page) {
        return tab
      }
      const { id: _id, isActive: _active, color: _color, isPinned: _pinned, ...live } = page
      return { ...tab, ...live }
    })
    // A launch draft the runtime already resolved is not shown again.
    return this.nativeChatDraftResolutions.applyFence({ ...snapshot, tabs })
  }

  /** Every worktree the holder publishes, empty or not. */
  protected sessionTabsWorktreeIds(): string[] {
    return this.sessionTabsStream.worktreeIds().filter((id) => !this.isSavedUnderRemovedRepo(id))
  }

  /**
   * Session keys outlive a repo removed elsewhere (#9343); listing one shows a phantom workspace.
   * Keys without a repo (floating terminals) never read the inventory, and a store that cannot
   * report repos removes none.
   */
  private isSavedUnderRemovedRepo(worktreeId: string): boolean {
    const repoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
    const repos = repoId ? this.store?.getRepos?.() : undefined
    return Array.isArray(repos) && !repos.some((repo) => repo.id === repoId)
  }

  protected sessionTabsSnapshots(): [string, RuntimeMobileSessionTabsSnapshot][] {
    const snapshots: [string, RuntimeMobileSessionTabsSnapshot][] = []
    for (const worktreeId of this.sessionTabsWorktreeIds()) {
      const snapshot = this.readSessionTabsSnapshot(worktreeId)
      if (snapshot) {
        snapshots.push([worktreeId, snapshot])
      }
    }
    return snapshots
  }

  protected scheduleMobileSessionTabsChanged(worktreeId: string): void {
    this.sessionTabsStream.bump(worktreeId)
    this.pendingMobileSessionTabsChangeSequenceByWorktree.set(
      worktreeId,
      ++this.mobileSessionTabsChangeSequence
    )
    this.sessionTabsStream.coalescer.schedule(worktreeId)
  }

  protected cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    this.sessionTabsStream.coalescer.cancel(worktreeId)
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
  }

  /** The holder published or removed a worktree. Publishes include every pane title and status
   *  change, so they share today's coalescer; mutations that must reach phones at once notify. */
  protected sessionTabsLayoutChanged(worktreeId: string, removed: boolean): void {
    // A wait for a surface re-checks on every layout publish, not only on window graph syncs.
    for (const check of this.graphSyncCallbacks.slice()) {
      check()
    }
    if (removed) {
      this.cancelScheduledMobileSessionTabsChanged(worktreeId)
      this.notifyMobileSessionTabsRemoved(worktreeId)
      return
    }
    this.pendingMobileSessionTabsChangeSequenceByWorktree.set(
      worktreeId,
      ++this.mobileSessionTabsChangeSequence
    )
    this.sessionTabsStream.coalescer.schedule(worktreeId)
  }

  protected flushScheduledMobileSessionTabsChanged(worktreeId: string): void {
    const changeSequence = this.pendingMobileSessionTabsChangeSequenceByWorktree.get(worktreeId)
    if (changeSequence === undefined) {
      return
    }
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  protected notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      return
    }
    // Why: browser bridge events are already worktree-scoped; don't fan out every workspace snapshot during navigation/tab churn.
    const result = this.toMobileSessionTabsResult(snapshot)
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
  }

  protected notifyMobileSessionTabSnapshots(): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    for (const worktreeId of this.sessionTabsWorktreeIds()) {
      this.sessionTabsStream.bump(worktreeId)
      const result = this.toMobileSessionTabsResult(this.readSessionTabsSnapshot(worktreeId)!)
      const changeSequence = ++this.mobileSessionTabsChangeSequence
      for (const subscription of this.mobileSessionTabListeners) {
        subscription.listener(
          this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
          changeSequence
        )
      }
    }
  }

  protected getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    return this.projectMobileSessionTabsForClient(
      snapshot
        ? this.toMobileSessionTabsResult(snapshot)
        : this.emptyMobileSessionTabsResult(worktreeId),
      clientNavigationId
    )
  }

  /** A worktree the holder does not publish has no tabs here. */
  protected emptyMobileSessionTabsResult(worktreeId: string): RuntimeMobileSessionTabsResult {
    return {
      worktree: worktreeId,
      publicationEpoch: this.sessionTabsStream.publicationEpoch,
      snapshotVersion: 0,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
  }

  protected emitMobileSessionTabsSnapshotToClient(
    projected: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    follow = false
  ): void {
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      if (subscription.clientNavigationId === clientNavigationId) {
        subscription.listener(
          follow ? { ...projected, navigationIntent: 'follow' } : projected,
          changeSequence
        )
      }
    }
  }

  protected async resolveMobileMarkdownWorktreeId(
    worktreeSelector: string,
    tabId: string
  ): Promise<string> {
    const worktreeId =
      this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  protected getLiveBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo> {
    const liveTabs = this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []
    const byPageId = new Map(liveTabs.map((tab) => [tab.browserPageId, tab]))
    for (const [index, page] of getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .entries()) {
      byPageId.set(page.browserPageId, {
        browserPageId: page.browserPageId,
        index: liveTabs.length + index,
        url: page.url,
        title: page.title,
        active: page.active,
        worktreeId,
        profileId: page.browserProfileId
      })
    }
    return byPageId
  }

  protected collectReturnedSessionTabIds(
    tabs: readonly RuntimeMobileSessionClientTab[]
  ): Set<string> {
    const ids = new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      } else if (tab.type === 'browser') {
        ids.add(tab.browserWorkspaceId)
      }
    }
    return ids
  }

  protected sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    if (!groups || groups.length === 0) {
      return undefined
    }
    const returnedIds = this.collectReturnedSessionTabIds(returnedTabs)
    const sanitized = groups
      .map((group): RuntimeMobileSessionTabGroup | null => {
        const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
        if (tabOrder.length === 0) {
          return null
        }
        const activeTabId =
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null)
        const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
        return {
          id: group.id,
          activeTabId,
          tabOrder,
          ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
        }
      })
      .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
    return sanitized.length > 0 ? sanitized : undefined
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

  /** Something a worktree's snapshot shows changed outside the layout: emit it now. */
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
    this.sessionTabsStream.bump(worktreeId)
    // Why: structural changes must propagate promptly; cancel any pending coalesced notify since this immediate emit supersedes it.
    this.cancelScheduledMobileSessionTabsChanged(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, ++this.mobileSessionTabsChangeSequence)
  }
}
