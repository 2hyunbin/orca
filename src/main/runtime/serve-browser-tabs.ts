// Browser tabs on a host with no window: saved as a window saves its own, and restored as a window
// restores them, lazily. A saved tab is listed at once; its page starts when something first uses
// it (a tap, a command, a stream), so a restart opens no pages by itself. A page a paired client
// runs for this host is saved the same way, but only that client ever starts it.

import type { BrowserBackend } from '../browser/browser-backend'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  findSavedBrowserPage,
  withActiveServeBrowserTab,
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
  /** The tab the layout shows for its worktree, as a window mounts it. */
  active: boolean
}

export class ServeBrowserTabs {
  private readonly restoring = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      /** True while no window saves this host's browser tabs. */
      windowless: () => boolean
      /** The page backend while no window hosts the browser tabs, else null. */
      backend: () => BrowserBackend | null
      /** A page a paired client runs for this host, live or waiting for that client. */
      isClientHosted: (pageId: string) => boolean
      /** Live pages in a worktree, or in every worktree when none is named. */
      livePageIds: (worktreeId: string | undefined) => ReadonlySet<string>
      /** Every workspace that holds a saved browser tab, whatever else it holds. */
      savedWorktreeIds: () => Iterable<string>
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

  /** The partition without the tabs showing these pages; a window's own tabs are left to it. */
  withoutTabs(
    worktreeId: string,
    session: WorkspaceSessionState,
    pageIds: readonly string[]
  ): WorkspaceSessionState {
    if (!this.deps.windowless()) {
      return session
    }
    const hostId = this.deps.hostId(worktreeId)
    return pageIds.reduce(
      (current, pageId) =>
        withClosedServeBrowserTab(hostId, current, worktreeId, pageId) ?? current,
      session
    )
  }

  /** Saved tabs whose page has not started, each by the page it shows; every worktree's if none. */
  listRestorable(
    worktreeId: string | undefined
  ): (RestorableBrowserPage & { worktreeId: string })[] {
    if (!this.deps.backend()) {
      return []
    }
    const worktreeIds = worktreeId ? [worktreeId] : [...new Set(this.deps.savedWorktreeIds())]
    return worktreeIds.flatMap((id) =>
      this.listRestorableIn(id).map((page) => ({ ...page, worktreeId: id }))
    )
  }

  /** The saved tab showing a page, which a window keys pin and colour by. */
  savedTabId(worktreeId: string, pageId: string): string | null {
    const session = this.deps.session(worktreeId)
    return session ? (findSavedBrowserPage(session, worktreeId, pageId)?.tabId ?? null) : null
  }

  private listRestorableIn(worktreeId: string): RestorableBrowserPage[] {
    const session = this.deps.session(worktreeId)
    if (!session) {
      return []
    }
    const live = this.deps.livePageIds(worktreeId)
    return (session.browserTabsByWorktree?.[worktreeId] ?? []).flatMap((tab) => {
      const pageId = tab.activePageId ?? tab.pageIds?.[0]
      const page = pageId ? findSavedBrowserPage(session, worktreeId, pageId)?.page : undefined
      // A document page is one desktop's; a remote page belongs to the host that ran it.
      if (
        !page ||
        live.has(page.id) ||
        page.docLocation ||
        page.remoteBrowserPageId ||
        this.deps.isClientHosted(page.id)
      ) {
        return []
      }
      return [
        {
          tabId: tab.id,
          pageId: page.id,
          url: page.url,
          title: page.title,
          profileId: tab.sessionProfileId ?? null,
          active: session.activeBrowserTabIdByWorktree?.[worktreeId] === tab.id
        }
      ]
    })
  }

  /** A switched-to page's tab is the one its worktree shows, as a window records it. */
  selected(worktreeId: string, pageId: string): void {
    const tabId = this.savedTabId(worktreeId, pageId)
    if (tabId) {
      this.write(worktreeId, (_hostId, session) =>
        withActiveServeBrowserTab(session, worktreeId, tabId)
      )
    }
  }

  /**
   * A command that names no page acts on the active page; with none running, that is the tab the
   * layout shows, as a window mounts it. False when nothing runs and the layout shows none.
   */
  async restoreActive(worktreeId: string | undefined): Promise<boolean> {
    if (this.deps.livePageIds(worktreeId).size > 0) {
      return false
    }
    // With no worktree named, the one the saved session shows, as a window opens on it.
    const scope =
      worktreeId ??
      [...this.deps.savedWorktreeIds()].find((id) => this.deps.session(id)?.activeWorktreeId === id)
    const active = scope && this.listRestorable(scope).find((page) => page.active)
    return active ? this.restore(scope, active.pageId) : false
  }

  /** The worktree of a saved tab whose page has not started, or null when none shows it. */
  restorableWorktreeOf(worktreeId: string | undefined, pageId: string): string | null {
    return (
      this.listRestorable(worktreeId).find((page) => page.pageId === pageId)?.worktreeId ?? null
    )
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
    const found = this.listRestorable(worktreeId).find((entry) => entry.pageId === pageId)
    if (!backend || !found) {
      return false
    }
    const started = backend
      .createTab({
        browserPageId: pageId,
        url: found.url,
        worktreeId: found.worktreeId,
        ...(found.profileId ? { profileId: found.profileId } : {})
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
    const session = this.deps.windowless() ? this.deps.session(worktreeId) : null
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
