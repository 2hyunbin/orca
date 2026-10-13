// Browser tabs on a host with no window: saved as a window saves its own, and restored as a window
// restores them, lazily. A saved tab is listed at once; its page starts when something first uses
// it (a tap, a command, a stream), so a restart opens no pages by itself.

import type { BrowserBackend } from '../browser/browser-backend'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  findSavedBrowserPage,
  withClosedServeBrowserTab,
  withOpenedServeBrowserTab,
  withServeBrowserPageState,
  type ServeBrowserPageState
} from './serve-browser-tab-layout'

export type RestorableBrowserPage = {
  /** The saved tab; a host's own tab is named by its page, a window's by its own id. */
  tabId: string
  pageId: string
  url: string
  title: string
  profileId: string | null
}

export class ServeBrowserTabs {
  private readonly restoring = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      /** The page backend while no window hosts the browser tabs, else null. */
      backend: () => BrowserBackend | null
      livePageIds: (worktreeId: string) => ReadonlySet<string>
      worktreeIds: () => Iterable<string>
      session: (worktreeId: string) => WorkspaceSessionState | null
      hostId: (worktreeId: string) => ExecutionHostId
      save: (worktreeId: string, session: WorkspaceSessionState) => void
    }
  ) {}

  opened(page: ServeBrowserPageState & { profileId?: string; groupId?: string }): void {
    this.write(page.worktreeId, (hostId, session) =>
      withOpenedServeBrowserTab(hostId, session, page)
    )
  }

  navigated(page: ServeBrowserPageState): void {
    this.write(page.worktreeId, (_hostId, session) => withServeBrowserPageState(session, page))
  }

  /** A closed page's tab; a page destroyed with the process is not a close. */
  closed(worktreeId: string, pageId: string): void {
    this.write(worktreeId, (hostId, session) =>
      withClosedServeBrowserTab(hostId, session, worktreeId, pageId)
    )
  }

  /** Saved tabs whose page has not started, each by the page it shows. */
  listRestorable(worktreeId: string): RestorableBrowserPage[] {
    const session = this.deps.backend() ? this.deps.session(worktreeId) : null
    if (!session) {
      return []
    }
    const live = this.deps.livePageIds(worktreeId)
    return (session.browserTabsByWorktree?.[worktreeId] ?? []).flatMap((tab) => {
      const pageId = tab.activePageId ?? tab.pageIds?.[0]
      const page = pageId ? findSavedBrowserPage(session, worktreeId, pageId)?.page : undefined
      // A document page is one desktop's; a remote page belongs to the host that ran it.
      if (!page || live.has(page.id) || page.docLocation || page.remoteBrowserPageId) {
        return []
      }
      return [
        {
          tabId: tab.id,
          pageId: page.id,
          url: page.url,
          title: page.title,
          profileId: tab.sessionProfileId ?? null
        }
      ]
    })
  }

  /**
   * Starts a saved tab's page, once however many callers ask; false when none is saved. A caller
   * that names only the page is answered from whichever workspace saved it.
   */
  async restore(worktreeId: string | undefined, pageId: string): Promise<boolean> {
    const pending = this.restoring.get(pageId)
    if (pending) {
      await pending
      return true
    }
    const backend = this.deps.backend()
    const owner = worktreeId ? [worktreeId] : [...this.deps.worktreeIds()]
    const found = owner.flatMap((id) =>
      this.listRestorable(id)
        .filter((entry) => entry.pageId === pageId)
        .map((page) => ({ worktreeId: id, page }))
    )[0]
    if (!backend || !found) {
      return false
    }
    const { page } = found
    const started = backend
      .createTab({
        browserPageId: pageId,
        url: page.url,
        worktreeId: found.worktreeId,
        ...(page.profileId ? { profileId: page.profileId } : {})
      })
      .then(() => undefined)
      .finally(() => this.restoring.delete(pageId))
    this.restoring.set(pageId, started)
    await started
    return true
  }

  private write(
    worktreeId: string,
    change: (
      hostId: ExecutionHostId,
      session: WorkspaceSessionState
    ) => WorkspaceSessionState | null
  ): void {
    const session = this.deps.backend() ? this.deps.session(worktreeId) : null
    const next = session ? change(this.deps.hostId(worktreeId), session) : null
    if (!next) {
      return
    }
    // Called from page events and closes; a refused write (writes frozen) must not throw there.
    try {
      this.deps.save(worktreeId, next)
    } catch (error) {
      console.warn('[serve-browser-tabs] could not save a browser tab:', error)
    }
  }
}
