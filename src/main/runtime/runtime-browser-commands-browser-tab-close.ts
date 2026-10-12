// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser } from './runtime-browser-commands-browser-profile-import-from-browser'
import { closeRuntimeBrowserClientPage } from './runtime-browser-client-page-creation'
import { BrowserError } from '../browser/browser-error'
import type { BrowserTabListResult } from '../../shared/runtime-types'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'

export class RuntimeBrowserCommandsWithBrowserTabClose extends RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser {
  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const pages = this.host.getRuntimeBrowserPageRegistry()
    let clientPage = params.page ? pages.getPage(params.page) : undefined
    if (clientPage) {
      await this.assertClientPageWorkspace(clientPage, params.worktree)
    } else if (!params.page) {
      const workspaceId = params.worktree
        ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
        : undefined
      if (pages.listPages(workspaceId).length > 0) {
        const tab =
          params.index !== undefined
            ? (await this.browserTabList({ worktree: params.worktree })).tabs[params.index]
            : (await this.browserTabCurrent({ worktree: params.worktree })).tab
        clientPage = tab ? pages.getPage(tab.browserPageId) : undefined
      }
    }
    if (clientPage) {
      const authority = this.host.getBrowserHostLeaseRegistry()
      // Why: a retained page whose host quit has no placement left to command, and asking the
      // absent host first would refuse the close and strand the tab with no way to dismiss it.
      if (authority.getPlacement(clientPage.browserPageId)) {
        await closeRuntimeBrowserClientPage(authority, {
          browserPageId: clientPage.browserPageId,
          placement: clientPage.placement
        })
      }
      if (!pages.retirePage(clientPage.browserPageId, clientPage.placement)) {
        throw new Error('browser_page_placement_stale')
      }
      if (this.host.retireRuntimeOwnedBrowserSessionTab) {
        this.host.retireRuntimeOwnedBrowserSessionTab(
          clientPage.workspaceId,
          clientPage.browserPageId
        )
      } else {
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(clientPage.workspaceId)
      }
      return { closed: true }
    }
    const namedPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : null
    const explicitPage = namedPageId !== null
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      // Why before the refusal: a runtime with no browser session cannot be holding this page
      // either, but it can still be carrying the session row that names it.
      if (
        namedPageId &&
        params.worktree &&
        this.retireGhostBrowserSessionRow(
          (await this.host.resolveWorktreeSelector(params.worktree)).id,
          namedPageId
        )
      ) {
        return { closed: true }
      }
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    const worktreeId = explicitPage
      ? params.worktree
        ? (await this.host.resolveWorktreeSelector(params.worktree)).id
        : undefined
      : await this.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (namedPageId !== null) {
      tabId = namedPageId
    } else if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    // Why: resolve the active page for implicit close so we don't report success while closing nothing.
    const resolvedTabId = tabId ?? bridge.getActivePageId(worktreeId)
    if (!resolvedTabId) {
      return { closed: false }
    }
    if (!bridge.getRegisteredTabs(worktreeId).has(resolvedTabId)) {
      if (this.retireGhostBrowserSessionRow(worktreeId, resolvedTabId)) {
        return { closed: true }
      }
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedTabId} was not found${scope}`
      )
    }
    // Why: headless serve destroys its offscreen page here; a window's <webview> goes when the
    // layout's tab does.
    if (!this.host.getAvailableAuthoritativeWindow()) {
      await this.host.getOffscreenBrowserBackend()?.closeTab(resolvedTabId)
    }
    const pageWorktreeId = worktreeId ?? browserManager.getWorktreeIdForTab(resolvedTabId)
    // Why: without retirement, paired clients keep a dead session tab until an unrelated republish.
    if (pageWorktreeId) {
      if (this.host.retireRuntimeOwnedBrowserSessionTab) {
        this.host.retireRuntimeOwnedBrowserSessionTab(pageWorktreeId, resolvedTabId)
      } else {
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(pageWorktreeId)
      }
    }
    return { closed: true }
  }

  protected enrichBrowserTabInfo(
    tab: BrowserTabListResult['tabs'][number]
  ): BrowserTabListResult['tabs'][number] {
    const rawProfileId = browserManager.getSessionProfileIdForTab(tab.browserPageId)
    const profile =
      browserSessionRegistry.getProfile(rawProfileId ?? 'default') ??
      browserSessionRegistry.getDefaultProfile()
    return {
      ...tab,
      worktreeId: browserManager.getWorktreeIdForTab(tab.browserPageId) ?? null,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }
}
