// What the old methods' translators and runtime-owned gestures do through the holder (PR 6c):
// read a held workspace, apply translated commands, start a pane a client opened, and move the
// desktop view, which old clients see as the host's selection.

import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  translateFileOpen,
  translateTerminalCreate
} from '../../shared/workspace-layout/old-client'
import type {
  LayoutCommand,
  LayoutCommandReply
} from '../../shared/workspace-layout/workspace-layout-command-types'
import {
  paneKeyOf,
  type WorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-model'
import {
  focusInViewRecord,
  navigateRequestFor
} from '../../shared/workspace-layout/workspace-layout-view-focus'
import {
  DESKTOP_VIEW_ID,
  resolveWorkspaceSelection
} from '../../shared/workspace-layout/workspace-layout-views'
import { mayStopClosedPaneTerminal, type ClosedPaneTerminal } from './closed-pane-terminal-stop'
import { OldSessionTabsStream } from './old-session-tabs-stream'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { LayoutCommandOptions } from './runtime-layout-commands'
import type { layoutCommandsFor } from './runtime-layout-command-host'
import { newTabIn, runtimeSplitPlacement } from './runtime-terminal-spawn-placement'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import { WindowPublishedPhoneRowFacts } from './window-published-phone-row-facts'
import { waitForHeldPaneTerminal } from './held-pane-terminal-wait'

export abstract class OrcaRuntimeWithHeldLayout extends OrcaRuntimeWithMigrationCatalog {
  protected abstract readonly layoutHolder: RuntimeWorkspaceLayouts
  abstract readonly layoutCommands: ReturnType<typeof layoutCommandsFor>
  private oldSessionTabsStream: OldSessionTabsStream | null = null
  private windowPublishedPhoneRowFacts: WindowPublishedPhoneRowFacts | null = null
  /** Set while a caller that stops and reports the closed tabs' processes itself applies a close. */
  private closedTerminalsStoppedByCaller = false
  /** The terminal a close's caller proved it addresses (main's `authorizedPty`), while it applies. */
  private closeAuthorizedPtyId: string | null = null

  /** Old clients' `session.tabs.*`: a projection of the holder with today's stream fields. */
  protected get sessionTabsStream(): OldSessionTabsStream {
    if (!this.oldSessionTabsStream) {
      this.oldSessionTabsStream = new OldSessionTabsStream({
        holder: this.layoutHolder,
        contentFacts: () => this.layoutCommands.views.contentFacts(DESKTOP_VIEW_ID),
        generatedTitlesEnabled: () => this.store?.getSettings?.().tabAutoGenerateTitle === true,
        issuedHandleOf: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId)[0] ?? null,
        changed: (worktreeId, removed) => this.sessionTabsLayoutChanged(worktreeId, removed),
        flush: (worktreeId) => this.flushScheduledMobileSessionTabsChanged(worktreeId)
      })
      this.watchGeneratedTitlesSetting()
    }
    return this.oldSessionTabsStream
  }

  /** Stack-internal until 6e: the window's published phone rows as holder views and content facts. */
  protected get windowPhoneRowFacts(): WindowPublishedPhoneRowFacts {
    this.windowPublishedPhoneRowFacts ??= new WindowPublishedPhoneRowFacts(
      this.layoutHolder,
      this.layoutCommands.views,
      (worktreeId) => this.scheduleMobileSessionTabsChanged(worktreeId)
    )
    return this.windowPublishedPhoneRowFacts
  }

  /** A workspace's layout as the holder holds it; absent for a workspace it does not hold. */
  heldWorkspaceLayout(worktreeId: string): WorkspaceLayout | undefined {
    const hostId = this.layoutHolder.hostIdOf(worktreeId)
    return hostId ? this.layoutHolder.model(hostId)?.workspaces[worktreeId] : undefined
  }

  /** The holder's close took each closed pane's records. */
  protected assertHeldTerminalsClosed(worktreeId: string): void {
    if (this.heldWorkspaceLayout(worktreeId)?.tabs.some((tab) => tab.kind === 'terminal')) {
      throw new Error('terminal_close_incomplete')
    }
  }

  /** The holder closed panes bound to these terminals. The close is committed; each stop is best-effort. */
  protected stopClosedTerminals(closed: readonly ClosedPaneTerminal[]): void {
    if (this.closedTerminalsStoppedByCaller) {
      return
    }
    for (const terminal of closed) {
      const { ptyId } = terminal
      const authorized = ptyId === this.closeAuthorizedPtyId
      if (!authorized && !mayStopClosedPaneTerminal(terminal, this.ptysById.get(ptyId))) {
        continue
      }
      this.stopExplicitlyClosedTabPtys([ptyId], '').catch((error: unknown) => {
        console.warn(`[runtime] failed to stop terminal ${ptyId}`, error)
      })
    }
  }

  /** Applies a close whose caller proved it addresses this terminal, which stops even if spawned for another tab. */
  protected withClosedTerminalAuthority<T>(ptyId: string | undefined, apply: () => T): T {
    this.closeAuthorizedPtyId = ptyId ?? null
    try {
      return apply()
    } finally {
      this.closeAuthorizedPtyId = null
    }
  }

  /** Applies a close whose processes the caller stops and reports (worktree close, `terminal.close`). */
  protected withClosedTerminalsStoppedByCaller<T>(apply: () => T): T {
    this.closedTerminalsStoppedByCaller = true
    try {
      return apply()
    } finally {
      this.closedTerminalsStoppedByCaller = false
    }
  }

  /** An old method's translated commands, applied in order; the first refusal stops the rest. */
  applyTranslatedLayoutCommands(
    commands: readonly LayoutCommand[],
    options: LayoutCommandOptions = { viewId: null }
  ): LayoutCommandReply {
    let reply: LayoutCommandReply = { ok: true }
    for (const command of commands) {
      reply = this.layoutCommands.apply(command, options)
      if (!reply.ok) {
        return reply
      }
    }
    return reply
  }

  /**
   * A client opened a terminal whose pane has no live terminal: the runtime starts the pane and
   * answers with the terminal it binds, or null once the start ends any other way. Serves every
   * subscribe that used to ask a window to mount the tab.
   */
  async startPaneForHandle(handle: string, signal?: AbortSignal): Promise<string | null> {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    const pane = { workspace: record.worktreeId, tabId: record.tabId, leafId: record.leafId }
    const paneKey = paneKeyOf(record.tabId, record.leafId)
    return await waitForHeldPaneTerminal(
      this.layoutHolder,
      pane,
      () =>
        this.layoutCommands.apply(
          { type: 'startPane', workspace: pane.workspace, paneKey },
          { viewId: null }
        ).ok,
      { signal }
    )
  }

  /**
   * Where a create's pane goes. An old desktop's `terminal.create {tabId, leafId}` names a pane it
   * already drew: a new pane in a tab the layout has is a split of that tab.
   */
  terminalCreatePlacement(
    worktreeId: string,
    tabId: string,
    leafId: string,
    opts: Parameters<typeof newTabIn>[0]
  ): ReturnType<typeof newTabIn> {
    const hostId = this.layoutHolder.hostIdOf(worktreeId)
    const model = hostId ? this.layoutHolder.model(hostId) : null
    const translated = model ? translateTerminalCreate(model, worktreeId, { tabId, leafId }) : null
    const split = translated?.ok ? translated.commands[0] : undefined
    return split?.type === 'splitPane'
      ? { placement: runtimeSplitPlacement(split.leafId, split.direction) }
      : newTabIn(opts)
  }

  /** `files.open`, or `files.openDiff` when `diff` is given: the runtime's layout opens the tab. */
  openHeldEditorFile(
    worktreeId: string,
    file: { filePath: string; relativePath: string },
    navigation: RuntimeNavigationTarget | undefined,
    diff?: { staged: boolean }
  ): void {
    const reply = this.applyTranslatedLayoutCommands([translateFileOpen(worktreeId, file, diff)])
    if (!reply.ok) {
      throw new Error(reply.code)
    }
    if (reply.tabId && navigationTargetsHost(navigation ?? 'host')) {
      this.navigateDesktopView(worktreeId, { tabId: reply.tabId })
    }
  }

  /** Gives a running terminal whose pane left the layout a new tab with that pane, bound to it. */
  protected admitRecoveredTerminal(
    worktreeId: string,
    pty: {
      ptyId: string
      paneKey: string | null
      incarnationId?: string | null
      launchAgent?: TuiAgent | null
    },
    placement: { groupId?: string; afterTabId?: string }
  ): void {
    const pane = parsePaneKey(pty.paneKey ?? '')
    const hostId = this.layoutHolder.hostIdOf(worktreeId)
    if (!pane || !hostId) {
      return
    }
    const applied = this.layoutHolder.apply(
      {
        type: 'createTerminalTab',
        workspace: worktreeId,
        ...pane,
        ...placement,
        ...(pty.launchAgent ? { creation: { launchAgent: pty.launchAgent } } : {})
      },
      hostId
    )
    const start = applied.ok ? applied.starts?.[0] : undefined
    if (start) {
      this.layoutHolder.bindStarted(
        hostId,
        {
          workspace: worktreeId,
          paneKey: start.paneKey,
          ptyId: pty.ptyId,
          ...(pty.incarnationId ? { incarnationId: pty.incarnationId } : {})
        },
        start.attempt
      )
    }
  }

  /**
   * The desktop view (which paired clients follow) shows a created terminal when asked to, or when
   * it shows nothing yet, as a window selects one it opens.
   */
  protected desktopViewShowsCreatedTerminal(
    worktreeId: string,
    presentation: RuntimeTerminalPresentation | undefined
  ): boolean {
    if (presentation === 'background') {
      return false
    }
    return presentation === 'focused' || !this.readSessionTabsSnapshot(worktreeId)?.activeTabId
  }

  /** Host navigation: the desktop view shows the target, and its window is told to go there. */
  protected navigateDesktopView(worktreeId: string, target: { tabId: string; leafId?: string }) {
    this.focusInDesktopView(worktreeId, target)
    const request = navigateRequestFor(worktreeId, this.heldWorkspaceLayout(worktreeId), target)
    if (request) {
      this.layoutCommands.views.navigate(DESKTOP_VIEW_ID, request)
    }
  }

  /** A terminal tab's rename the user set, which `terminal.list` shows first (#19582). */
  heldTabCustomTitle(terminalTabId: string): string | null {
    const location = this.layoutHolder.findTerminalTab(terminalTabId)
    const tab = location
      ? this.heldWorkspaceLayout(location.workspace)?.tabs.find(
          (entry) => entry.id === location.tabId
        )
      : undefined
    return tab?.customTitle?.trim() || null
  }

  /** A pane title, or a sole pane's tab rename, the user set; it beats every live title (#19582). */
  heldUserTitle(worktreeId: string, parentTabId: string, leafId: string): string | null {
    const workspace = this.heldWorkspaceLayout(worktreeId)
    const tab = workspace?.tabs.find(
      (candidate) => candidate.kind === 'terminal' && candidate.entityId === parentTabId
    )
    if (tab?.kind !== 'terminal') {
      return null
    }
    const paneTitle = workspace?.leaves?.[leafId]?.title?.trim()
    const sole = tab.panes.root?.type === 'leaf'
    return paneTitle || (sole ? tab.customTitle?.trim() : '') || null
  }

  /** The group the desktop view shows in a workspace, where a runtime-opened tab joins it. */
  protected desktopActiveGroup(worktreeId: string): { groupId?: string } {
    const workspace = this.heldWorkspaceLayout(worktreeId)
    const record = this.layoutCommands.views.record(DESKTOP_VIEW_ID)
    const groupId = workspace
      ? resolveWorkspaceSelection(record, worktreeId, workspace).activeGroupId
      : null
    return groupId ? { groupId } : {}
  }

  /** Shows a tab (and pane) in the desktop view, which old phones see as the host's selection. */
  focusInDesktopView(worktreeId: string, target: { tabId: string; leafId?: string }): void {
    const workspace = this.heldWorkspaceLayout(worktreeId)
    if (!workspace) {
      return
    }
    const { views } = this.layoutCommands
    const record = views.record(DESKTOP_VIEW_ID)
    const next = focusInViewRecord(record, worktreeId, workspace, target)
    if (next !== record) {
      views.setRecord(DESKTOP_VIEW_ID, next)
      // A view record is saved, never published on the layout stream.
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }
}
