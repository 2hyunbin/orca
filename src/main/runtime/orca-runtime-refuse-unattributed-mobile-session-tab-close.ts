// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './orca-runtime-apply-mobile-session-tab-navigation'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { withUnlistedTerminalTab } from './unlisted-terminal-tab-close'

export class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  /** The list a close resolves its tab in; with no window, a tab only another partition holds too. */
  protected closeSnapshotFor(
    worktreeId: string,
    tabId: string | null | undefined
  ): RuntimeMobileSessionTabsSnapshot | undefined {
    const listed = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (
      !listed ||
      !tabId ||
      !this.isWindowlessSessionTabs() ||
      listed.tabs.some((tab) => tab.id === tabId || tab.parentTabId === tabId)
    ) {
      return listed
    }
    const [holderId] = this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
    const holder = holderId ? (this.store?.getWorkspaceSession?.(holderId) ?? null) : null
    return withUnlistedTerminalTab(listed, tabId, holder)
  }

  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const snapshot = await this.listMobileSessionTabs(worktreeSelector)
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    // Why: a legacy client may already have hidden its mirror; a new snapshot
    // restores it without granting an unattributed request destructive authority.
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }
}
