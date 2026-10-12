// Old clients' editor tabs: `files.open`/`files.openDiff` as an `openEditorTab` command, and an
// editor, diff or markdown-preview tab as today's `session.tabs` row.

import type { EditorTabView } from '../../editor-tab-view-types'
import { detectLanguage } from '../../language-detect'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../runtime-mobile-session-tab-contracts'
import type { LayoutCommand } from '../workspace-layout-command-types'
import type { LayoutContentTab, WorkspaceLayout } from '../workspace-layout-model'
import type { LayoutViewRecord } from '../workspace-layout-views'

type EditorRowScope = {
  key: string
  workspace: WorkspaceLayout
  view: Pick<LayoutViewRecord, 'editorDrafts'>
  activeTabId: string | null
}

/** `files.open`, or `files.openDiff` when `diff` is given, for a host with no window. */
export function translateFileOpen(
  workspace: string,
  file: { filePath: string; relativePath: string },
  diff?: { staged: boolean }
): Extract<LayoutCommand, { type: 'openEditorTab' }> {
  const withLanguage = { ...file, language: detectLanguage(file.filePath) }
  if (!diff) {
    return {
      type: 'openEditorTab',
      workspace,
      fileId: file.filePath,
      contentType: 'editor',
      file: withLanguage
    }
  }
  const view: EditorTabView = {
    mode: 'diff',
    diffSource: diff.staged ? 'staged' : 'unstaged',
    file: withLanguage
  }
  return {
    type: 'openEditorTab',
    workspace,
    // The window's id for a host-local diff, so a later window adopts the same tab.
    fileId: `${workspace}::diff::${view.diffSource}::${file.relativePath}`,
    contentType: 'diff',
    view
  }
}

export function editorTabRow(
  tab: LayoutContentTab,
  scope: EditorRowScope
): RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab | null {
  return editorViewRow(tab, scope) ?? (tab.kind === 'editor' ? editFileRow(tab, scope) : null)
}

/** Only edit-mode files are in the model; other editor tabs are the desktop view's own. */
function editFileRow(
  tab: LayoutContentTab,
  scope: EditorRowScope
): RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab | null {
  const file = scope.workspace.editorFiles?.find((entry) => entry.filePath === tab.entityId)
  if (!file) {
    return null
  }
  const common = {
    id: tab.id,
    title: file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File',
    filePath: file.filePath,
    relativePath: file.relativePath,
    isDirty: scope.view.editorDrafts[scope.key]?.[file.filePath]?.dirtyDraftContent !== undefined,
    color: tab.color ?? null,
    isPinned: tab.isPinned === true,
    isActive: scope.activeTabId === tab.id
  }
  if (file.language === 'markdown') {
    return {
      ...common,
      type: 'markdown',
      language: 'markdown',
      mode: 'edit',
      sourceFileId: file.filePath,
      sourceFilePath: file.filePath,
      sourceRelativePath: file.relativePath,
      documentVersion: `file:${file.filePath}`
    }
  }
  return { ...common, type: 'file', language: file.language, mode: 'edit' }
}

/** Diff and markdown-preview tabs, from the unsaved view their opener recorded (P16). */
function editorViewRow(
  tab: LayoutContentTab,
  scope: EditorRowScope
): RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab | null {
  const view = scope.workspace.editorViews?.[tab.id]
  const file = view?.mode === 'diff' || view?.mode === 'markdown-preview' ? view.file : undefined
  // Combined diffs name a display label, not a file, and need the desktop to draw them.
  if (!view || !file || (view.mode === 'diff' && view.diffSource?.startsWith('combined-'))) {
    return null
  }
  const common = {
    id: tab.id,
    title: file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File',
    filePath: file.filePath,
    relativePath: file.relativePath,
    isDirty: scope.view.editorDrafts[scope.key]?.[file.filePath]?.dirtyDraftContent !== undefined,
    color: tab.color ?? null,
    isPinned: tab.isPinned === true,
    isActive: scope.activeTabId === tab.id
  }
  if (view.mode === 'markdown-preview') {
    return {
      ...common,
      type: 'markdown',
      language: 'markdown',
      mode: 'markdown-preview',
      sourceFileId: file.filePath,
      sourceFilePath: file.filePath,
      sourceRelativePath: file.relativePath,
      documentVersion: `file:${file.filePath}`
    }
  }
  const diffSource =
    view.mode === 'diff' && (view.diffSource === 'staged' || view.diffSource === 'unstaged')
      ? view.diffSource
      : undefined
  return {
    ...common,
    type: 'file',
    language: file.language,
    mode: 'diff',
    ...(diffSource ? { diffSource } : {})
  }
}
