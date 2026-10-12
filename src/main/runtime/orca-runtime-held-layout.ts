// What the old methods' translators and runtime-owned gestures do through the holder (PR 6c):
// read a held workspace, apply translated commands, start a pane a client opened, and move the
// desktop view, which old clients see as the host's selection.

import {
  navigationTargetsHost,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
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
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import { focusInViewRecord } from '../../shared/workspace-layout/workspace-layout-view-focus'
import {
  DESKTOP_VIEW_ID,
  resolveWorkspaceSelection
} from '../../shared/workspace-layout/workspace-layout-views'
import { OldSessionTabsStream } from './old-session-tabs-stream'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { LayoutCommandOptions } from './runtime-layout-commands'
import type { layoutCommandsFor } from './runtime-layout-command-host'
import { newTabIn, runtimeSplitPlacement } from './runtime-terminal-spawn-placement'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import { WindowPublishedEditorViews } from './window-published-editor-views'

export abstract class OrcaRuntimeWithHeldLayout extends OrcaRuntimeWithMigrationCatalog {
  protected abstract readonly layoutHolder: RuntimeWorkspaceLayouts
  abstract readonly layoutCommands: ReturnType<typeof layoutCommandsFor>
  private oldSessionTabsStream: OldSessionTabsStream | null = null
  private windowPublishedEditorViews: WindowPublishedEditorViews | null = null
  /** Set while a caller that stops and reports the closed tabs' processes itself applies a close. */
  private closedTerminalsStoppedByCaller = false

  /** Old clients' `session.tabs.*`: a projection of the holder with today's stream fields. */
  protected get sessionTabsStream(): OldSessionTabsStream {
    this.oldSessionTabsStream ??= new OldSessionTabsStream({
      holder: this.layoutHolder,
      contentFacts: () => this.layoutCommands.views.contentFacts(DESKTOP_VIEW_ID),
      generatedTitlesEnabled: () => this.store?.getSettings?.().tabAutoGenerateTitle === true,
      issuedHandleOf: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId)[0] ?? null,
      changed: (worktreeId, removed) => this.sessionTabsLayoutChanged(worktreeId, removed),
      flush: (worktreeId) => this.flushScheduledMobileSessionTabsChanged(worktreeId)
    })
    return this.oldSessionTabsStream
  }

  /** Stack-internal until 6e: the window's published diff and preview rows as holder views. */
  protected get windowEditorViews(): WindowPublishedEditorViews {
    this.windowPublishedEditorViews ??= new WindowPublishedEditorViews(this.layoutHolder)
    return this.windowPublishedEditorViews
  }

  /** A workspace's layout as the holder holds it; absent for a workspace it does not hold. */
  heldWorkspaceLayout(worktreeId: string): WorkspaceLayout | undefined {
    const hostId = this.layoutHolder.hostIdOf(worktreeId)
    return hostId ? this.layoutHolder.model(hostId)?.workspaces[worktreeId] : undefined
  }

  /** The holder's close took each closed pane's records; a window's close (until PR 6d) did not. */
  protected assertHeldTerminalsClosed(worktreeId: string): void {
    if (this.heldWorkspaceLayout(worktreeId)?.tabs.some((tab) => tab.kind === 'terminal')) {
      throw new Error('terminal_close_incomplete')
    }
  }

  /** The holder closed panes bound to these terminals. The close is committed; each stop is best-effort. */
  protected stopClosedTerminals(ptyIds: readonly string[]): void {
    if (this.closedTerminalsStoppedByCaller) {
      return
    }
    for (const ptyId of ptyIds) {
      // A dormant local id can name another session after a restart; only a live or SSH id is stop authority.
      if (!this.ptysById.get(ptyId)?.connected && !parseAppSshPtyId(ptyId)) {
        continue
      }
      this.stopExplicitlyClosedTabPtys([ptyId], '').catch((error: unknown) => {
        console.warn(`[runtime] failed to stop terminal ${ptyId}`, error)
      })
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

  /** Until PR 6d a window that owns the layout mounts its panes; without one the runtime starts them. */
  startsPanesForSubscribers(): boolean {
    return !this.getAvailableAuthoritativeWindow()
  }

  /**
   * A client opened a terminal whose pane has no live terminal: the runtime starts the pane and
   * answers with the terminal it binds, or null once the start ends any other way. Serves every
   * subscribe that used to ask a window to mount the tab.
   */
  async startPaneForHandle(handle: string, signal?: AbortSignal): Promise<string | null> {
    const record = this.handles.get(handle)
    if (!record || signal?.aborted) {
      return null
    }
    const workspace = record.worktreeId
    const paneKey = paneKeyOf(record.tabId, record.leafId)
    const paneOf = (layout: PublishedWorkspaceLayout | undefined) =>
      layout?.tabs
        .flatMap((tab) => (tab.entityId === record.tabId ? (tab.terminal?.panes ?? []) : []))
        .find((pane) => pane.leafId === record.leafId)
    const settled = (pane: ReturnType<typeof paneOf>): string | null | undefined => {
      if (!pane) {
        return null
      }
      if (pane.status === 'running' && pane.ptyId) {
        return pane.ptyId
      }
      return pane.status === 'starting' || pane.status === 'restorable' ? undefined : null
    }
    const now = settled(paneOf(this.layoutHolder.published(workspace)))
    if (now !== undefined) {
      return now
    }
    return await new Promise<string | null>((resolve) => {
      const finish = (ptyId: string | null): void => {
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(ptyId)
      }
      const onAbort = (): void => finish(null)
      const { unsubscribe } = this.layoutHolder.subscribe((event) => {
        if (event.key !== workspace) {
          return
        }
        const result = settled(event.type === 'workspace' ? paneOf(event.layout) : undefined)
        if (result !== undefined) {
          finish(result)
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const reply = this.layoutCommands.apply(
        { type: 'startPane', workspace, paneKey },
        { viewId: null }
      )
      if (!reply.ok) {
        finish(null)
      }
    })
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

  /** `files.open`, or `files.openDiff` when `diff` is given, with no window: the runtime's layout opens the tab. */
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
      this.focusInDesktopView(worktreeId, { tabId: reply.tabId })
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
   * With no window to reveal a created terminal, the desktop view (which paired clients follow)
   * shows it when asked to, or when it shows nothing yet, as a window selects one it opens.
   */
  protected desktopViewShowsCreatedTerminal(
    worktreeId: string,
    presentation: RuntimeTerminalPresentation | undefined
  ): boolean {
    if (this.getAvailableAuthoritativeWindow() || presentation === 'background') {
      return false
    }
    return presentation === 'focused' || !this.readSessionTabsSnapshot(worktreeId)?.activeTabId
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
    views.setRecord(
      DESKTOP_VIEW_ID,
      focusInViewRecord(views.record(DESKTOP_VIEW_ID), worktreeId, workspace, target)
    )
    // A view record is saved, never published on the layout stream.
    this.notifyMobileSessionTabsChanged(worktreeId)
  }
}
