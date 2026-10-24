import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './headless-terminal-tab-close'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../pty-recorded-surface-topology'
import { withSelectedTabs } from '../headless-tab-group-selection'
import { buildHeadlessTabGroupMove } from '../../../shared/workspace-layout/tab-group-moves'
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
      this.placeMovedPaneTab(worktreeId, move.targetTabId, placement)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
    return result
  }

  /** Puts the committed tab where the client dropped it, selected, before the one publish. */
  private placeMovedPaneTab(
    worktreeId: string,
    tabId: string,
    placement: MovedPanePlacement | undefined
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const groupsBefore = snapshot?.tabGroups ?? []
    const target = groupsBefore.find((group) => group.id === placement?.targetGroupId)
    // A group the host does not know keeps the tab where the commit appended it.
    if (!snapshot || !placement || !target) {
      return
    }
    const sameGroupOrder = target.tabOrder.filter((id) => id !== tabId)
    sameGroupOrder.splice(
      Math.max(0, Math.min(placement.index ?? sameGroupOrder.length, sameGroupOrder.length)),
      0,
      tabId
    )
    const moved = buildHeadlessTabGroupMove({
      groups: groupsBefore,
      layout: snapshot.tabGroupLayout,
      tabId,
      targetGroupId: target.id,
      index: placement.index
    }) ?? {
      groups: groupsBefore.map((group) => ({
        id: group.id,
        tabOrder: group.id === target.id ? sameGroupOrder : group.tabOrder
      })),
      layout: snapshot.tabGroupLayout ?? null
    }
    const groups = withSelectedTabs(groupsBefore, moved.groups, tabId)
    const layout = moved.layout ?? { type: 'leaf' as const, groupId: target.id }
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
