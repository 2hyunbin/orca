// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { RuntimeHeadlessTerminalTabClose } from './session-tabs/headless-terminal-tab-close'
import type { RuntimeHeadlessTabProperties } from './session-tabs/headless-tab-properties'
import type { RuntimeHeadlessTabGroups } from './session-tabs/headless-tab-group-moves'
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './orca-runtime-close-structured-agent-session-tab'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult
} from '../../shared/runtime-types'

import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'

export class OrcaRuntimeWithCloseHeadlessMobileTerminalTab extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
  protected closeHeadlessMobileTerminalTab(
    ...args: Parameters<RuntimeHeadlessTerminalTabClose['closeHeadlessMobileTerminalTab']>
  ): ReturnType<RuntimeHeadlessTerminalTabClose['closeHeadlessMobileTerminalTab']> {
    return this.runtimeHeadlessTerminalTabClose.closeHeadlessMobileTerminalTab(...args)
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    if (!this.notifier?.moveSessionTab) {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      this.notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return { moved: true }
    }
    this.notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return { moved: true }
  }

  // Why: pane geometry inside a tab (split ratios, expanded pane, pane titles)
  // is host-authoritative for remote-server tabs but had no push path, so a
  // client divider-drag / expand / pane-rename reverted on the next snapshot.
  // Persist the structural fields onto the tab's layout, keeping host-owned
  // pty bindings and active leaf.
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      chatLeafId?: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Persist only headlessly.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const resolvedArgs = { ...args, tabId: hostTabId }
    const acceptedLayout = this.persistHeadlessTerminalPaneLayout(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      this.applyHeadlessTerminalPaneLayoutToSnapshot(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        chatLeafId: acceptedLayout.chatLeafId ?? null,
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
  }

  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, args)
    return { updated: true }
  }

  protected persistHeadlessSessionTabProps(
    ...args: Parameters<RuntimeHeadlessTabProperties['persistHeadlessSessionTabProps']>
  ): ReturnType<RuntimeHeadlessTabProperties['persistHeadlessSessionTabProps']> {
    return this.headlessSessionTabCommands.properties.persistHeadlessSessionTabProps(...args)
  }

  protected applyHeadlessSessionTabPropsToSnapshot(
    ...args: Parameters<RuntimeHeadlessTabProperties['applyHeadlessSessionTabPropsToSnapshot']>
  ): ReturnType<RuntimeHeadlessTabProperties['applyHeadlessSessionTabPropsToSnapshot']> {
    return this.headlessSessionTabCommands.properties.applyHeadlessSessionTabPropsToSnapshot(
      ...args
    )
  }

  protected getMobileSessionTopLevelTabId(
    ...args: Parameters<RuntimeHeadlessTabProperties['getMobileSessionTopLevelTabId']>
  ): ReturnType<RuntimeHeadlessTabProperties['getMobileSessionTopLevelTabId']> {
    return this.headlessSessionTabCommands.properties.getMobileSessionTopLevelTabId(...args)
  }

  protected persistHeadlessTerminalPaneLayout(
    ...args: Parameters<RuntimeHeadlessTabProperties['persistHeadlessTerminalPaneLayout']>
  ): ReturnType<RuntimeHeadlessTabProperties['persistHeadlessTerminalPaneLayout']> {
    return this.headlessSessionTabCommands.properties.persistHeadlessTerminalPaneLayout(...args)
  }

  protected applyHeadlessTerminalPaneLayoutToSnapshot(
    ...args: Parameters<RuntimeHeadlessTabProperties['applyHeadlessTerminalPaneLayoutToSnapshot']>
  ): ReturnType<RuntimeHeadlessTabProperties['applyHeadlessTerminalPaneLayoutToSnapshot']> {
    return this.headlessSessionTabCommands.properties.applyHeadlessTerminalPaneLayoutToSnapshot(
      ...args
    )
  }

  protected moveHeadlessMobileSessionTab(
    ...args: Parameters<RuntimeHeadlessTabGroups['moveHeadlessMobileSessionTab']>
  ): ReturnType<RuntimeHeadlessTabGroups['moveHeadlessMobileSessionTab']> {
    return this.headlessSessionTabCommands.groups.moveHeadlessMobileSessionTab(...args)
  }

  protected persistHeadlessTabGroups(
    ...args: Parameters<RuntimeHeadlessTabGroups['persistHeadlessTabGroups']>
  ): ReturnType<RuntimeHeadlessTabGroups['persistHeadlessTabGroups']> {
    return this.headlessSessionTabCommands.groups.persistHeadlessTabGroups(...args)
  }
}
