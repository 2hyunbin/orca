import {
  resolveWorkspaceViewerTab,
  SESSION_TAB_IDENTITY
} from '../../../../shared/workspace-creation-tab'
import {
  activateClientSessionTabSelection,
  deriveClientSessionTabSelection,
  projectClientSessionTabSelection
} from '../../client-session-tab-selection'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { holdAgentSessionInventory } from '../../structured-agent-session-inventory-hold'
import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from '../../session-tabs/terminal-surface-retirements'

export abstract class OrcaRuntimeWithClientSessionTabProjection extends OrcaRuntimeWithPersistTerminalSurfaceRetirements {
  /**
   * Answers one client's session-tabs question: whether this runtime has taken back *that* client's
   * client-hosted pages yet and can say which chats exist, then that client's own tab selection.
   *
   * The holds are decided here and nowhere else, and each is set or cleared rather than only set,
   * so a frame built for one client can never carry another client's, or an earlier, answer.
   */
  protected projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const scope = parseWorkspaceKey(result.worktree)
    const session = this.getWorkspaceSessionForWorktree(result.worktree)
    const groups = session?.tabGroups?.[result.worktree] ?? []
    const activeGroup = session?.activeGroupIdByWorktree?.[result.worktree]
    const chosenTabId =
      groups.find((group) => group.id === activeGroup)?.activeTabId ??
      groups.find((group) => group.activeTabId)?.activeTabId
    const createdWithAgent =
      scope?.type === 'folder'
        ? this.store?.getFolderWorkspace?.(scope.folderWorkspaceId)?.createdWithAgent
        : this.store?.getWorktreeMetaForHost?.(
            result.worktree,
            this.getWorkspaceSessionHostIdForWorktree(result.worktree)
          )?.createdWithAgent
    const shown = resolveWorkspaceViewerTab(
      result.tabs,
      { chosenTabId, createdWithAgent },
      SESSION_TAB_IDENTITY
    )
    const host = shown
      ? projectClientSessionTabSelection(
          result,
          activateClientSessionTabSelection(
            result,
            deriveClientSessionTabSelection(result),
            shown.id
          )
        ).snapshot
      : result
    return this.clientSessionTabSelections.project(
      this.withSessionTabsHolds(host, clientNavigationId),
      clientNavigationId
    )
  }

  protected withSessionTabsHolds(result: RuntimeMobileSessionTabsResult, navigationId?: string) {
    const held = this.clientHostedPageReconciliation.holdFor(result, navigationId, Date.now())
    return holdAgentSessionInventory(held, this.structuredAgentSessionInventoryUnverifiable)
  }
}
