import { collectMobileVisibleGraphChangedWorktrees } from './session-graph/mobile-visible-graph-changes'
import type { RuntimeSessionWindowGraphHost } from './session-graph/session-window-graph'
import type { RuntimeSessionTabsInventory } from './session-tabs/session-tabs-inventory'
import { OrcaRuntimeWithSyncWindowGraph } from './orca-runtime-sync-window-graph'

export class OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees extends OrcaRuntimeWithSyncWindowGraph {
  // Why: toMobileSessionTabsResult resolves handles/titles from this.tabs and
  // this.leaves, so any tab/leaf delta a graph sync installs can flip the
  // client payload (pending-handle → ready, tab title) with zero change to the
  // stored snapshot. Compare exactly the projection-relevant fields and report
  // the affected worktrees; false positives only cost a coalesced no-op emit.

  listMobileSessionTabs(
    ...args: Parameters<RuntimeSessionTabsInventory['listMobileSessionTabs']>
  ): ReturnType<RuntimeSessionTabsInventory['listMobileSessionTabs']> {
    return this.runtimeSessionTabsInventory.listMobileSessionTabs(...args)
  }

  listAllMobileSessionTabs(
    ...args: Parameters<RuntimeSessionTabsInventory['listAllMobileSessionTabs']>
  ): ReturnType<RuntimeSessionTabsInventory['listAllMobileSessionTabs']> {
    return this.runtimeSessionTabsInventory.listAllMobileSessionTabs(...args)
  }

  listAllMobileSessionTabsWithChangeSequence(
    ...args: Parameters<RuntimeSessionTabsInventory['listAllMobileSessionTabsWithChangeSequence']>
  ): ReturnType<RuntimeSessionTabsInventory['listAllMobileSessionTabsWithChangeSequence']> {
    return this.runtimeSessionTabsInventory.listAllMobileSessionTabsWithChangeSequence(...args)
  }

  listAllMobileSessionTabsInventory(
    ...args: Parameters<RuntimeSessionTabsInventory['listAllMobileSessionTabsInventory']>
  ): ReturnType<RuntimeSessionTabsInventory['listAllMobileSessionTabsInventory']> {
    return this.runtimeSessionTabsInventory.listAllMobileSessionTabsInventory(...args)
  }

  listAllMobileSessionTabsInventoryWithChangeSequence(
    ...args: Parameters<
      RuntimeSessionTabsInventory['listAllMobileSessionTabsInventoryWithChangeSequence']
    >
  ): ReturnType<
    RuntimeSessionTabsInventory['listAllMobileSessionTabsInventoryWithChangeSequence']
  > {
    return this.runtimeSessionTabsInventory.listAllMobileSessionTabsInventoryWithChangeSequence(
      ...args
    )
  }

  supportsAuthoritativeSessionTabsInventory(
    ...args: Parameters<RuntimeSessionTabsInventory['supportsAuthoritativeSessionTabsInventory']>
  ): ReturnType<RuntimeSessionTabsInventory['supportsAuthoritativeSessionTabsInventory']> {
    return this.runtimeSessionTabsInventory.supportsAuthoritativeSessionTabsInventory(...args)
  }

  protected waitForSessionTabsInventoryPublication(
    ...args: Parameters<RuntimeSessionTabsInventory['waitForSessionTabsInventoryPublication']>
  ): ReturnType<RuntimeSessionTabsInventory['waitForSessionTabsInventoryPublication']> {
    return this.runtimeSessionTabsInventory.waitForSessionTabsInventoryPublication(...args)
  }

  protected getAuthoritativeSessionTabsInventoryEpoch(
    ...args: Parameters<RuntimeSessionTabsInventory['getAuthoritativeSessionTabsInventoryEpoch']>
  ): ReturnType<RuntimeSessionTabsInventory['getAuthoritativeSessionTabsInventoryEpoch']> {
    return this.runtimeSessionTabsInventory.getAuthoritativeSessionTabsInventoryEpoch(...args)
  }

  protected markSessionTabsInventoryPublished(
    ...args: Parameters<RuntimeSessionTabsInventory['markSessionTabsInventoryPublished']>
  ): ReturnType<RuntimeSessionTabsInventory['markSessionTabsInventoryPublished']> {
    return this.runtimeSessionTabsInventory.markSessionTabsInventoryPublished(...args)
  }

  protected collectAllMobileSessionTabs(
    ...args: Parameters<RuntimeSessionTabsInventory['collectAllMobileSessionTabs']>
  ): ReturnType<RuntimeSessionTabsInventory['collectAllMobileSessionTabs']> {
    return this.runtimeSessionTabsInventory.collectAllMobileSessionTabs(...args)
  }

  protected settleSessionTabsInventory(
    ...args: Parameters<RuntimeSessionTabsInventory['settleSessionTabsInventory']>
  ): ReturnType<RuntimeSessionTabsInventory['settleSessionTabsInventory']> {
    return this.runtimeSessionTabsInventory.settleSessionTabsInventory(...args)
  }

  protected assertSessionTabsInventoryRequestActive(
    ...args: Parameters<RuntimeSessionTabsInventory['assertSessionTabsInventoryRequestActive']>
  ): ReturnType<RuntimeSessionTabsInventory['assertSessionTabsInventoryRequestActive']> {
    return this.runtimeSessionTabsInventory.assertSessionTabsInventoryRequestActive(...args)
  }

  protected isCompleteSessionTabsPtyCensus(
    ...args: Parameters<RuntimeSessionTabsInventory['isCompleteSessionTabsPtyCensus']>
  ): ReturnType<RuntimeSessionTabsInventory['isCompleteSessionTabsPtyCensus']> {
    return this.runtimeSessionTabsInventory.isCompleteSessionTabsPtyCensus(...args)
  }

  protected collectMobileVisibleGraphChangedWorktrees(
    ...args: Parameters<RuntimeSessionWindowGraphHost['collectMobileVisibleGraphChangedWorktrees']>
  ): ReturnType<RuntimeSessionWindowGraphHost['collectMobileVisibleGraphChangedWorktrees']> {
    return collectMobileVisibleGraphChangedWorktrees(this.runtimeGraphState, ...args)
  }
}
