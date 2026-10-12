// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseMobileSessionTab } from './orca-runtime-close-mobile-session-tab'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { BrowserError } from '../browser/browser-error'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionCloseCause } from '../native-chat/agent-session-wire/structured-agent-session-host-lifetime'

export class OrcaRuntimeWithCloseStructuredAgentSessionTab extends OrcaRuntimeWithCloseMobileSessionTab {
  protected async closeStructuredAgentSessionTab(
    tab: RuntimeMobileSessionAgentTab,
    cause: StructuredAgentSessionCloseCause
  ): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (host) {
      if (typeof host.setSessionTabVisibility === 'function') {
        // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
        // failing disk) is reported, and the tab still closes.
        await host.setSessionTabVisibility(tab.sessionId, false).catch((error: unknown) => {
          host.deps.logger.warn('recording a closed chat tab failed', {
            scope: 'tab-visibility-close',
            sessionId: tab.sessionId,
            error
          })
        })
      }
    }
    // Retire durable visibility and the runtime snapshot before stopping the provider.
    this.retireStructuredAgentSessionTabFromSnapshot(tab.sessionId)
    if (typeof host?.close === 'function') {
      await host.close(tab.sessionId, cause)
    }
  }

  /**
   * Prunes a structured session's chat tab from whichever worktree snapshot still carries it.
   *
   * Public because orchestration settles structured workers outside the tab surface: stop, release
   * and the half-started discard all prove their own close and then have to retire the tab that
   * `publishStructuredAgentSessionTab` put on screen. `setSessionTabVisibility(false)` only clears
   * the DURABLE restore index, so without this the dead chat tab survives for the rest of the app
   * session and re-attaches the released session when opened.
   *
   * Snapshot-only and renderer-free: it never asks the renderer to close anything, so it is safe on
   * the startup release reconciler where no renderer exists.
   */
  retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean {
    for (const worktreeId of this.sessionTabsWorktreeIds()) {
      const tab = this.heldWorkspaceLayout(worktreeId)?.tabs.find(
        (candidate) => candidate.kind === 'agent-session' && candidate.entityId === sessionId
      )
      if (tab) {
        this.applyTranslatedLayoutCommands([
          { type: 'closeTabs', workspace: worktreeId, tabIds: [tab.id], force: true }
        ])
        return true
      }
    }
    return false
  }

  // Why: a refused echoed close means the echoing client already pruned its local mirror. A new
  // version re-adds and re-attaches the still-live tab on clients that dedupe by version.
  protected republishMobileSessionTabsSnapshot(worktreeId: string): void {
    this.notifyMobileSessionTabsChanged(worktreeId)
  }

  protected getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (!pty) {
      return null
    }
    return this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // Why: before the layout guard — worktree removal drops the workspace first, and the host
    // rows for its client pages would otherwise be stranded on screen with nothing to retract them.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const tab = this.heldBrowserTabForPage(worktreeId, browserPageId)
    if (!tab) {
      return false
    }
    this.applyTranslatedLayoutCommands([
      { type: 'closeTabs', workspace: worktreeId, tabIds: [tab.id], force: true }
    ])
    return true
  }

  /** The held browser tab whose record names this page. */
  protected heldBrowserTabForPage(worktreeId: string, browserPageId: string) {
    const workspace = this.heldWorkspaceLayout(worktreeId)
    const record = workspace?.browserTabs?.find((entry) => entry.pageIds?.includes(browserPageId))
    return record
      ? workspace?.tabs.find((tab) => tab.kind === 'browser' && tab.entityId === record.id)
      : undefined
  }

  /** A page the runtime created: the holder adds the tab that shows it. */
  addHeadlessBrowserLayoutTab(
    worktreeId: string,
    browserPageId: string,
    groupId?: string,
    profileId?: string
  ): void {
    if (!this.heldBrowserTabForPage(worktreeId, browserPageId)) {
      this.applyTranslatedLayoutCommands([
        {
          type: 'openBrowserTab',
          workspace: worktreeId,
          pageId: browserPageId,
          ...(groupId ? { groupId } : {}),
          ...(profileId ? { profileId } : {})
        }
      ])
    }
  }

  /** `browser tab set-profile`: the held tab showing this page takes the profile. */
  setHeldBrowserTabProfile(
    worktreeId: string | undefined,
    browserPageId: string,
    profile: BrowserSessionProfile
  ): void {
    // An explicit page names no workspace: look in every one the runtime holds.
    const candidates = worktreeId
      ? [worktreeId]
      : this.layoutHolder
          .loadedHostIds()
          .flatMap((hostId) => Object.keys(this.layoutHolder.model(hostId)?.workspaces ?? {}))
    const owner = candidates.find((id) => this.heldBrowserTabForPage(id, browserPageId))
    const tab = owner ? this.heldBrowserTabForPage(owner, browserPageId) : undefined
    if (!owner || !tab) {
      throw new BrowserError('browser_no_tab', `Browser tab ${browserPageId} not found`)
    }
    const reply = this.applyTranslatedLayoutCommands([
      {
        type: 'setBrowserTabProfile',
        workspace: owner,
        tabId: tab.entityId,
        profileId: profile.id,
        sessionPartition: profile.partition
      }
    ])
    if (!reply.ok) {
      throw new BrowserError('browser_no_tab', `Browser tab ${browserPageId} not found`)
    }
  }

  protected markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void {
    if (!worktreeId) {
      return
    }
    this.addHeadlessBrowserLayoutTab(worktreeId, browserPageId, options.targetGroupId)
    const tab = this.heldBrowserTabForPage(worktreeId, browserPageId)
    if (!tab) {
      return
    }
    if (options.focusesHost) {
      this.focusInDesktopView(worktreeId, { tabId: tab.id })
    }
    if (options.caller) {
      // Why: the originating device still lands on the tab it just created; only the shared
      // snapshot stayed put. Local creates keep the pre-navigation shape by having no caller.
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        tab.id,
        options.caller.navigation,
        options.caller.clientNavigationId
      )
    }
  }
}
