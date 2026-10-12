// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './orca-runtime-close-structured-agent-session-tab'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import {
  resolveSessionTabRow,
  translateSessionTabClose,
  translateSessionTabMove,
  translateSetTabProps,
  translateUpdatePaneLayout
} from '../../shared/workspace-layout/old-client'

export class OrcaRuntimeWithCloseHeadlessMobileTerminalTab extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
  /** Closes a terminal row's whole tab in the holder; its terminals stop as the close applies. */
  protected async closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: { authorizedPty?: RuntimePtyWorktreeRecord; force?: boolean; killPtys?: boolean } = {}
  ): Promise<void> {
    const close = () =>
      this.closeHeldSessionTab(worktreeId, tab.parentTabId, { force: options.force })
    if (options.killPtys === false) {
      this.withClosedTerminalsStoppedByCaller(close)
    } else {
      // A dormant SSH session the tab last attached (no pane binds it) stops with the tab, as today.
      const dormant =
        this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[tab.parentTabId]
      this.withClosedTerminalAuthority(options.authorizedPty?.ptyId, close)
      if (dormant) {
        this.stopClosedTerminals([{ ptyId: dormant }])
      }
    }
    // As today, the close replies once it is on disk.
    await this.layoutHolder.whenDurable()
    this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, tab.parentTabId)
    if (options.authorizedPty) {
      options.authorizedPty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(options.authorizedPty.ptyId, false)
    }
  }

  /**
   * An old client's close of a row (`session.tabs.close`, design 2.6): a pane row closes its pane,
   * any other terminal row its tab, which a pinned tab refuses with today's `terminal_tab_pinned`.
   */
  protected closeHeldSessionTab(
    worktreeId: string,
    rowId: string,
    options: { force?: boolean; allowMissing?: boolean } = {}
  ): void {
    const translated = translateSessionTabClose(worktreeId, this.heldWorkspaceLayout(worktreeId), {
      tabId: rowId
    })
    if (!translated.ok) {
      throw new Error(translated.code)
    }
    const commands = options.force
      ? translated.commands.map((command) =>
          command.type === 'closeTabs' ? { ...command, force: true } : command
        )
      : translated.commands
    const reply = this.applyTranslatedLayoutCommands(commands)
    if (!reply.ok) {
      // A workspace the holder does not hold has nothing to close here.
      if (options.allowMissing && reply.code === 'workspace_not_found') {
        return
      }
      throw new Error(reply.code)
    }
    const refused = reply.refused?.[0]
    if (refused) {
      throw new Error(refused.code === 'tab_pinned' ? 'terminal_tab_pinned' : refused.code)
    }
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove,
    caller: { clientNavigationId?: string } = {}
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.readSessionTabsSnapshot(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    const workspace = this.heldWorkspaceLayout(worktreeId)
    if (!workspace) {
      throw new Error('tab_not_found')
    }
    const translated = translateSessionTabMove(
      worktreeId,
      workspace,
      this.toMobileSessionTabsResult(snapshot),
      move
    )
    if (!translated.ok) {
      throw new Error(translated.code)
    }
    const reply = this.applyTranslatedLayoutCommands(translated.commands)
    if (!reply.ok) {
      throw new Error(reply.code)
    }
    if (caller.clientNavigationId) {
      // Q3: the move selects the moved tab in the sender's view only; observers keep theirs.
      const moved = this.getMobileSessionTabsForWorktree(worktreeId)
      const row = moved.tabs.find(
        (tab) =>
          tab.id === move.tabId || (tab.type === 'terminal' && tab.parentTabId === move.tabId)
      )
      if (row) {
        this.applyMobileSessionTabNavigation(moved, row.id, 'caller', caller.clientNavigationId)
      }
    }
    return { moved: true }
  }

  /** An old desktop's pane tree, as the commands that reach it (rule 11). */
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      chatLeafId?: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: boolean }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    const workspace = this.heldWorkspaceLayout(worktreeId)
    const tab = workspace ? resolveSessionTabRow(workspace, args.tabId)?.tab : undefined
    if (!workspace || tab?.kind !== 'terminal') {
      return { updated: true }
    }
    const { commands, structureRefused } = translateUpdatePaneLayout(
      worktreeId,
      workspace,
      tab,
      args
    )
    this.applyTranslatedLayoutCommands(commands)
    return { updated: !structureRefused }
  }

  /** Tab color, pin and mode, as `setTabProps`. */
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
    const workspace = this.heldWorkspaceLayout(worktreeId)
    const translated = workspace ? translateSetTabProps(worktreeId, workspace, args) : null
    if (translated?.ok) {
      this.applyTranslatedLayoutCommands(translated.commands)
    }
    return { updated: true }
  }
}
