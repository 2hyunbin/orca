import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isSameEditorOwner, resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { pluginViewerFileId } from '../file-ids/plugin-viewer-file-id'
import { migrateHydratedEditorTabsAndGroups } from '../file-ids/hydrated-editor-file-ids'
import { rekeyFileIdRecord } from '../file-ids/open-file-path-rekey'
import { resolveExistingEditorViewIntent } from './editor-read-only-view-intent'
import { pluginViewerReopenState } from './plugin-viewer-reopen-state'

export function fileOpeningTransition(
  state: AppState,
  file: OpenFile,
  viewerKey: string
): Partial<AppState> {
  const source = file.fileOpening ?? { readOnly: true }
  const incoming: OpenFile = {
    ...file,
    isDirty: false,
    mode: viewerKey === 'core' ? 'edit' : 'plugin-viewer',
    fileOpening: undefined,
    fileOpeningChoicePending: undefined,
    fileOpeningOwnerUnresolved: undefined,
    pluginViewer: viewerKey === 'core' ? undefined : { key: viewerKey, sourceView: source },
    readOnly: viewerKey === 'core' ? source.readOnly || undefined : true,
    liveTail: viewerKey === 'core' && source.readOnly ? source.liveTail : undefined
  }
  const existing = state.openFiles.find(
    (candidate) =>
      candidate.id !== file.id &&
      candidate.mode === incoming.mode &&
      candidate.filePath === file.filePath &&
      candidate.externalSshTargetId === file.externalSshTargetId &&
      isSameEditorOwner(candidate, file.worktreeId, file.runtimeEnvironmentId) &&
      (viewerKey === 'core' || candidate.pluginViewer?.key === viewerKey)
  )
  const nextId =
    existing?.id ??
    (viewerKey === 'core'
      ? resolveEditorFileIdForOwner(
          state,
          file.filePath,
          file.worktreeId,
          file.runtimeEnvironmentId,
          ['edit']
        )
      : pluginViewerFileId(file.filePath, file.worktreeId, file.runtimeEnvironmentId, viewerKey))
  const migrations = new Map([[file.id, nextId]])
  const migrated = migrateHydratedEditorTabsAndGroups(
    {
      unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? {},
      groupsByWorktree: state.groupsByWorktree ?? {}
    },
    { [file.worktreeId]: migrations }
  )
  const tabs =
    migrated.unifiedTabsByWorktree?.[file.worktreeId] ??
    state.unifiedTabsByWorktree?.[file.worktreeId] ??
    []
  const redirects = new Map<string, string>()
  const promoted = new Map<string, { isPinned?: boolean; isPreview?: boolean }>()
  const originalTabs = state.unifiedTabsByWorktree?.[file.worktreeId] ?? []
  const keptTabs = tabs.filter((tab, index) => {
    if (originalTabs[index]?.entityId !== file.id || tab.contentType !== 'editor') {
      return true
    }
    const targetIndex = originalTabs.findIndex(
      (candidate) =>
        candidate.groupId === tab.groupId &&
        candidate.contentType === 'editor' &&
        candidate.entityId === nextId
    )
    const target = targetIndex === -1 ? undefined : tabs[targetIndex]
    if (!target) {
      return true
    }
    redirects.set(tab.id, target.id)
    promoted.set(target.id, {
      isPinned: target.isPinned || tab.isPinned || undefined,
      isPreview: target.isPreview && tab.isPreview ? true : undefined
    })
    return false
  })
  const groups =
    migrated.groupsByWorktree?.[file.worktreeId] ?? state.groupsByWorktree?.[file.worktreeId] ?? []
  const redirectOrder = (ids: string[]): string[] => [
    ...new Set(ids.map((id) => redirects.get(id) ?? id))
  ]
  const focus = state.pendingEditorFocusRequest
  const reveal = state.pendingEditorReveal
  const migrateViewRecord = <T>(record: Record<string, T>): Record<string, T> =>
    existing
      ? Object.fromEntries(Object.entries(record).filter(([id]) => id !== file.id))
      : rekeyFileIdRecord(record, migrations)
  return {
    openFiles: state.openFiles.flatMap((candidate) =>
      candidate.id === file.id
        ? existing
          ? []
          : [{ ...incoming, id: nextId }]
        : candidate.id === existing?.id
          ? [
              {
                ...candidate,
                ...resolveExistingEditorViewIntent(candidate, incoming),
                ...pluginViewerReopenState(state, candidate, incoming)
              }
            ]
          : [candidate]
    ),
    ...migrated,
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      ...migrated.unifiedTabsByWorktree,
      [file.worktreeId]: keptTabs.map((tab) =>
        promoted.has(tab.id) ? { ...tab, ...promoted.get(tab.id) } : tab
      )
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      ...migrated.groupsByWorktree,
      [file.worktreeId]: groups.map((group) => ({
        ...group,
        activeTabId: group.activeTabId
          ? (redirects.get(group.activeTabId) ?? group.activeTabId)
          : null,
        tabOrder: redirectOrder(group.tabOrder),
        ...(group.recentTabIds ? { recentTabIds: redirectOrder(group.recentTabIds) } : {})
      }))
    },
    activeFileId: state.activeFileId === file.id ? nextId : state.activeFileId,
    activeFileIdByWorktree: {
      ...state.activeFileIdByWorktree,
      ...(state.activeFileIdByWorktree[file.worktreeId] === file.id
        ? { [file.worktreeId]: nextId }
        : {})
    },
    tabBarOrderByWorktree: {
      ...state.tabBarOrderByWorktree,
      ...(state.tabBarOrderByWorktree?.[file.worktreeId]
        ? {
            [file.worktreeId]: [
              ...new Set(
                state.tabBarOrderByWorktree[file.worktreeId].map(
                  (id) => migrations.get(id) ?? redirects.get(id) ?? id
                )
              )
            ]
          }
        : {})
    },
    editorDrafts: Object.fromEntries(
      Object.entries(state.editorDrafts).filter(([id]) => id !== file.id)
    ),
    editorCursorLine: migrateViewRecord(state.editorCursorLine),
    markdownViewMode: migrateViewRecord(state.markdownViewMode),
    markdownRichModeSizeOverride: migrateViewRecord(state.markdownRichModeSizeOverride),
    editorViewMode: migrateViewRecord(state.editorViewMode),
    markdownFrontmatterVisible: migrateViewRecord(state.markdownFrontmatterVisible),
    markdownTableOfContentsVisible: migrateViewRecord(state.markdownTableOfContentsVisible),
    ...(reveal?.fileId === file.id ? { pendingEditorReveal: { ...reveal, fileId: nextId } } : {}),
    ...(focus?.fileId === file.id
      ? {
          pendingEditorFocusRequest: {
            ...focus,
            fileId: nextId,
            viewStateId:
              migrations.get(focus.viewStateId) ??
              redirects.get(focus.viewStateId) ??
              focus.viewStateId
          }
        }
      : {})
  }
}
