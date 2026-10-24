import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './headless-terminal-tab-close'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../pty-recorded-surface-topology'
import { withSelectedTabs } from '../headless-tab-group-selection'
import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-session-contracts'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import {
  isTerminalLeafMoveRequest,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'

/** Where the client dropped the new tab, in the host's group ids. */
export type MovedPanePlacement = { targetGroupId: string; index?: number }

export abstract class OrcaRuntimeWithHeadlessPaneMoveToNewTab extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  protected abstract persistHeadlessTabGroups(
    ...args: Parameters<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>
  ): ReturnType<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>

  // Why: a client's pane-to-new-tab move must reach the host session or the next snapshot rebuilds
  // the old tab. A window-owned host keeps its layout in the renderer, so only headless hosts commit.
  async moveMobileSessionLeafToNewTab(
    worktreeSelector: string,
    args: { sourceTabId: string; targetTabId: string; leafId: string },
    commit: (move: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>,
    placement?: MovedPanePlacement
  ): Promise<TerminalLeafMoveResult> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    if (this.getAvailableAuthoritativeWindow()) {
      return { status: 'not_held' }
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Why: the client's pty id mirrors a host handle; the host names its own bound pty.
    const move = { ...args, worktreeId, ptyId: null }
    if (!isValidHostTerminalTabId(move.targetTabId) || !isTerminalLeafMoveRequest(move)) {
      return { status: 'refused', reason: 'invalid_request' }
    }
    // The order the user sees; a rebuild after the commit puts terminals ahead of editors and pages.
    const groupsBefore = this.mobileSessionTabsByWorktree.get(worktreeId)?.tabGroups ?? []
    const result = await commit(move)
    if (result.status === 'moved') {
      // The live PTY follows its pane, or tab-scoped reads and actions still find it in the source.
      const pty = result.ptyId ? this.ptysById.get(result.ptyId) : undefined
      if (pty) {
        recordPtySurface(
          pty,
          move.targetTabId,
          makePaneKey(move.targetTabId, move.leafId),
          spawnSurfaceClaimSequence(this.graphSequence)
        )
      }
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
      this.placeMovedPaneTab(worktreeId, move, groupsBefore, placement)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
    return result
  }

  /**
   * Puts the committed tab where the client dropped it, selected, into the order from before the
   * commit, so the user's other tabs keep their places; without a drop position it goes last in its
   * source's group. Published by the caller.
   */
  private placeMovedPaneTab(
    worktreeId: string,
    move: { sourceTabId: string; targetTabId: string },
    groupsBefore: readonly RuntimeMobileSessionTabGroup[],
    placement: MovedPanePlacement | undefined
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const target =
      groupsBefore.find((group) => group.id === placement?.targetGroupId) ??
      groupsBefore.find((group) => group.tabOrder.includes(move.sourceTabId))
    if (!snapshot || !target) {
      return
    }
    const tabId = move.targetTabId
    const order = target.tabOrder.filter((id) => id !== tabId)
    const index = target.id === placement?.targetGroupId ? placement.index : undefined
    order.splice(Math.max(0, Math.min(index ?? order.length, order.length)), 0, tabId)
    const groups = withSelectedTabs(
      groupsBefore,
      groupsBefore.map((group) => ({
        id: group.id,
        tabOrder: group.id === target.id ? order : group.tabOrder
      })),
      tabId
    )
    const layout = snapshot.tabGroupLayout ?? { type: 'leaf' as const, groupId: target.id }
    const surface = snapshot.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === tabId
    )
    this.persistHeadlessTabGroups(worktreeId, groups, layout)
    this.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      activeGroupId: target.id,
      ...(surface
        ? {
            activeTabId: surface.id,
            activeTabType: surface.type,
            tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: tab.id === surface.id }))
          }
        : {}),
      tabGroups: groups,
      tabGroupLayout: layout
    })
  }
}
