import type { RuntimeMobileSessionBrowserTab } from '../../shared/runtime-types'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'

/** Session-tab rows for pages paired clients run for this host's worktree. */
export function clientHostedSessionBrowserTabs(
  pages: readonly RuntimeBrowserClientPage[]
): RuntimeMobileSessionBrowserTab[] {
  return pages.map((page) => ({
    type: 'browser' as const,
    id: page.browserPageId,
    title: page.title || page.url || 'Browser',
    browserWorkspaceId: page.browserPageId,
    browserPageId: page.browserPageId,
    browserProfileId: page.browserProfileId,
    executionHostKey: page.executionHostKey,
    placement: page.placement,
    url: page.url,
    loading: page.loading,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    isActive: page.active
  }))
}
