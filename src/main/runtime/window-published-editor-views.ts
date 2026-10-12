// Stack-internal bridge (PR 6c until 6e, never reaches main alone). Until the window opens editor
// tabs through `openEditorTab {view}` (6d), only its published phone rows say which file a diff or
// markdown-preview tab shows; the view is not saved, so the holder loads those tabs without it.
// Each row the window publishes becomes its tab's view in the holder. Deleted in 6e with the
// window's publisher.

import { isDeepStrictEqual } from 'node:util'
import type { EditorTabView } from '../../shared/editor-tab-view-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

type Holder = Pick<RuntimeWorkspaceLayouts, 'subscribe' | 'apply' | 'hostIdOf' | 'model'>

export class WindowPublishedEditorViews {
  private readonly byWorktree = new Map<string, Map<string, EditorTabView>>()

  constructor(private readonly holder: Holder) {
    // A view can arrive before the session save that adds its tab; the reload publishes the tab.
    holder.subscribe((event) => {
      if (event.type !== 'removed' && this.byWorktree.has(event.key)) {
        queueMicrotask(() => this.applyTo(event.key))
      }
    })
  }

  /** The authoritative window published these worktrees' phone rows. */
  noteWindowRows(snapshots: readonly RuntimeMobileSessionTabsSnapshot[]): void {
    for (const snapshot of snapshots) {
      const views = viewsOf(snapshot.tabs)
      if (views.size === 0) {
        this.byWorktree.delete(snapshot.worktree)
        continue
      }
      this.byWorktree.set(snapshot.worktree, views)
      this.applyTo(snapshot.worktree)
    }
  }

  private applyTo(key: string): void {
    const views = this.byWorktree.get(key)
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
