// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs } from './orca-runtime-reconcile-headless-mobile-session-browser-tabs'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

export class OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding extends OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs {
  protected clearRuntimeSessionOwnershipForMobileTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    parentTabId: string
  ): void {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal' || tab.parentTabId !== parentTabId) {
        continue
      }
      const ptyIds = [tab.ptyId, ...Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})].filter(
        (ptyId): ptyId is string => typeof ptyId === 'string'
      )
      for (const ptyId of ptyIds) {
        const pty = this.ptysById.get(ptyId)
        if (pty?.worktreeId === worktreeId && pty.tabId === parentTabId) {
          pty.runtimeSessionOwned = false
          this.setPairedRendererSessionOwnership(pty.ptyId, false)
        }
      }
    }
  }
}
