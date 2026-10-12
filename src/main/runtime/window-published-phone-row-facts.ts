// Stack-internal bridge (PR 6c until 6e, never reaches main alone). Until the window opens editor
// tabs through `openEditorTab {view}` (6d) and reports `view.contentFacts` (6e), only its published
// phone rows say which file a diff or markdown-preview tab shows, which terminal theme it paints and
// which launch draft a terminal's composer holds. Each row the window publishes becomes its tab's
// view in the holder, and the rows' theme and drafts become the desktop view's content facts.
// Deleted in 6e with the window's publisher.

import { isDeepStrictEqual } from 'node:util'
import type { EditorTabView } from '../../shared/editor-tab-view-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import { DESKTOP_VIEW_ID } from '../../shared/workspace-layout/workspace-layout-views'
import type { LayoutViewContentFacts, RuntimeLayoutViews } from './runtime-layout-views'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

type Holder = Pick<RuntimeWorkspaceLayouts, 'subscribe' | 'apply' | 'hostIdOf' | 'model'>
type LaunchDrafts = NonNullable<LayoutViewContentFacts['launchDrafts']>
type RowContentFacts = Pick<LayoutViewContentFacts, 'terminalTheme'> & {
  launchDrafts: LaunchDrafts
}

export class WindowPublishedPhoneRowFacts {
  private readonly viewsByWorktree = new Map<string, Map<string, EditorTabView>>()
  private readonly contentFactsByWorktree = new Map<string, RowContentFacts>()
  /** The window's own pane trees, synced with its graph: a close it lists resolves against them, as on main. */
  private readonly paneTreesByWorktree = new Map<string, Map<string, TerminalLayoutSnapshot>>()

  constructor(
    private readonly holder: Holder,
    private readonly views: Pick<RuntimeLayoutViews, 'setContentFacts'>,
    /** A worktree's rows now show another theme or draft: phones need its snapshot again. */
    private readonly contentFactsChanged: (worktreeId: string) => void
  ) {
    // A view can arrive before the session save that adds its tab; the reload publishes the tab.
    holder.subscribe((event) => {
      if (event.type !== 'removed' && this.viewsByWorktree.has(event.key)) {
        queueMicrotask(() => this.applyTo(event.key))
      }
    })
  }

  /** The authoritative window published these worktrees' phone rows. */
  noteWindowRows(snapshots: readonly RuntimeMobileSessionTabsSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.noteContentFacts(snapshot)
      this.paneTreesByWorktree.set(snapshot.worktree, paneTreesOf(snapshot.tabs))
      const views = viewsOf(snapshot.tabs)
      if (views.size === 0) {
        this.viewsByWorktree.delete(snapshot.worktree)
        continue
      }
      this.viewsByWorktree.set(snapshot.worktree, views)
      this.applyTo(snapshot.worktree)
    }
  }

  /** The tab's pane tree as the window last published it; undefined when it published none. */
  windowPaneTree(worktreeId: string, tabId: string): TerminalLayoutSnapshot | undefined {
    return this.paneTreesByWorktree.get(worktreeId)?.get(tabId)
  }

  private noteContentFacts(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    const next = contentFactsOf(snapshot.tabs)
    const previous = this.contentFactsByWorktree.get(snapshot.worktree) ?? { launchDrafts: {} }
    if (isDeepStrictEqual(previous, next)) {
      return
    }
    this.contentFactsByWorktree.set(snapshot.worktree, next)
    const launchDrafts: LaunchDrafts = {}
    for (const facts of this.contentFactsByWorktree.values()) {
      Object.assign(launchDrafts, facts.launchDrafts)
    }
    this.views.setContentFacts(DESKTOP_VIEW_ID, {
      ...(next.terminalTheme ? { terminalTheme: next.terminalTheme } : {}),
      launchDrafts
    })
    this.contentFactsChanged(snapshot.worktree)
  }

  private applyTo(key: string): void {
    const views = this.viewsByWorktree.get(key)
    const hostId = this.holder.hostIdOf(key)
    const workspace = hostId ? this.holder.model(hostId)?.workspaces[key] : undefined
    for (const [tabId, view] of views ?? []) {
      const tab = workspace?.tabs.find((candidate) => candidate.id === tabId)
      if (
        (tab?.kind === 'editor' || tab?.kind === 'diff') &&
        !isDeepStrictEqual(workspace?.editorViews?.[tabId], view)
      ) {
        this.holder.apply({
          type: 'openEditorTab',
          workspace: key,
          fileId: tab.entityId,
          contentType: tab.kind,
          view
        })
      }
    }
  }
}

function contentFactsOf(rows: readonly RuntimeMobileSessionSnapshotTab[]): RowContentFacts {
  const launchDrafts: LaunchDrafts = {}
  let terminalTheme: LayoutViewContentFacts['terminalTheme']
  for (const row of rows) {
    if (row.type !== 'terminal') {
      continue
    }
    terminalTheme ??= row.terminalTheme
    if (row.launchDraft !== undefined && row.launchDraftCreatedAt !== undefined) {
      launchDrafts[row.parentTabId] = { text: row.launchDraft, createdAt: row.launchDraftCreatedAt }
    }
  }
  return { ...(terminalTheme ? { terminalTheme } : {}), launchDrafts }
}

function viewsOf(rows: readonly RuntimeMobileSessionSnapshotTab[]): Map<string, EditorTabView> {
  const views = new Map<string, EditorTabView>()
  for (const row of rows) {
    if (row.type === 'file' && row.mode === 'diff') {
      const file = {
        filePath: row.filePath,
        relativePath: row.relativePath,
        language: row.language
      }
      views.set(row.id, {
        mode: 'diff',
        file,
        ...(row.diffSource ? { diffSource: row.diffSource } : {})
      })
    } else if (row.type === 'markdown' && row.mode === 'markdown-preview') {
      const file = { filePath: row.filePath, relativePath: row.relativePath, language: 'markdown' }
      views.set(row.id, {
        mode: 'markdown-preview',
        file,
        markdownPreviewSourceFileId: row.sourceFileId
      })
    }
  }
  return views
}

function paneTreesOf(
  rows: readonly RuntimeMobileSessionSnapshotTab[]
): Map<string, TerminalLayoutSnapshot> {
  const trees = new Map<string, TerminalLayoutSnapshot>()
  for (const row of rows) {
    if (row.type === 'terminal' && row.parentLayout && !trees.has(row.parentTabId)) {
      trees.set(row.parentTabId, row.parentLayout)
    }
  }
  return trees
}
