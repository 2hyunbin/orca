import { describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'

vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: { resolveKnownPartition: () => 'persist:orca-browser' }
}))

/** A host with no window: the offscreen backend runs the page and served tabs save it. */
function headlessCreation() {
  const opened = vi.fn()
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => ({
    browserPageId: browserPageId ?? 'minted-page'
  }))
  const creation = new RuntimeBrowserTabCreation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offscreen create reads only the members stubbed here.
    {
      getAgentBrowserBridge: () => null,
      resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserNetworkExecutionHost: vi.fn(),
      getBrowserHostLeaseRegistry: vi.fn(),
      getRuntimeBrowserPageRegistry: vi.fn(),
      getAvailableAuthoritativeWindow: () => null,
      getOffscreenBrowserBackend: () => ({ createTab, closeTab: vi.fn() }),
      getAuthoritativeWindow: () => null,
      markHeadlessBrowserSessionTabActive: vi.fn(),
      notifyHeadlessBrowserSessionTabsChanged: vi.fn(),
      serveBrowserTabs: { opened, start: vi.fn() }
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offscreen create calls no command target.
    { requireAgentBrowserBridge: vi.fn(), notifyRendererNavigation: vi.fn() } as never
  )
  return { creation, opened }
}

describe('a browser create on a host with no window', () => {
  it('names the tab a new page joins to the served tabs', async () => {
    const host = headlessCreation()

    await host.creation.browserTabCreate({
      worktree: 'id:wt-1',
      url: 'https://example.com/b',
      page: 'page-2',
      browserTabId: 'tab-1'
    })

    expect(host.opened).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      pageId: 'page-2',
      url: 'https://example.com/b',
      title: '',
      browserTabId: 'tab-1'
    })
  })

  it('names no tab when the create asks for a new one', async () => {
    const host = headlessCreation()

    await host.creation.browserTabCreate({ worktree: 'id:wt-1', url: 'https://example.com/' })

    expect(host.opened).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      pageId: 'minted-page',
      url: 'https://example.com/',
      title: ''
    })
  })
})
