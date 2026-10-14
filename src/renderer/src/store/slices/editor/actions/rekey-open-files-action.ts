import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { OpenFilePathRekey, RekeyOpenFilesResult } from '../types/open-file-path-rekey'
import { rekeyFileIdRecord } from '../file-ids/open-file-path-rekey'
import { migrateHydratedEditorTabsAndGroups } from '../file-ids/hydrated-editor-file-ids'

export function createRekeyOpenFilesAction(
  set: EditorSet,
  _get: EditorGet
): Pick<EditorSlice, 'rekeyOpenFilesForPathChange'> {
  return {
    rekeyOpenFilesForPathChange: ({ rekeys, moveOperationId }) => {
      if (rekeys.length === 0) {
        return { ok: true }
      }
      let result: RekeyOpenFilesResult = { ok: true }
      set((s) => {
        const migrations = new Map<string, string>()
        const rekeyByOldId = new Map<string, OpenFilePathRekey>()
        for (const rekey of rekeys) {
          migrations.set(rekey.oldFileId, rekey.newFileId)
          rekeyByOldId.set(rekey.oldFileId, rekey)
        }
        const openById = new Map(s.openFiles.map((f) => [f.id, f]))

        // Preflight (atomic with apply): every source still open, target ids unique,
        // and no target id belongs to an UNAFFECTED live session (never merge two).
        const seenNewIds = new Set<string>()
        for (const rekey of rekeys) {
          if (!openById.has(rekey.oldFileId)) {
            result = { ok: false, reason: 'stale' }
            return s
          }
          if (seenNewIds.has(rekey.newFileId)) {
            result = { ok: false, reason: 'collision' }
            return s
          }
          seenNewIds.add(rekey.newFileId)
          const occupier = openById.get(rekey.newFileId)
          if (occupier && !migrations.has(occupier.id)) {
            result = { ok: false, reason: 'collision' }
            return s
          }
        }

        const nextOpenFiles = s.openFiles.map((f) => {
          const rekey = rekeyByOldId.get(f.id)
          if (!rekey) {
            return f
          }
          // Spread the whole OpenFile so fields this action doesn't know about survive; change only the path-derived ones.
          // Gate atomically here so autosave is suspended before any echo can be verified (only a dirty autosave-capable tab can be clobbered).
          const gatesEcho =
            moveOperationId !== undefined &&
            f.isDirty &&
            // A 'changed' tab is already autosave-suspended via externalMutation; gating it would strand the gate (verification skips a 'changed' tab), so leave the banner as terminal.
            f.externalMutation !== 'changed' &&
            (f.mode === 'edit' || (f.mode === 'diff' && f.diffSource === 'unstaged'))
          return {
            ...f,
            id: rekey.newFileId,
            filePath: rekey.newFilePath,
            relativePath: rekey.newRelativePath,
            // A moved tab's id no longer matches the host snapshot, so leaving it host-owned would cull it (losing the draft); the coordinator close-notifies the host's old-path tab. (Re-homing the host tab in place is a follow-up.)
            mirroredFromRuntimeSession: undefined,
            ...(rekey.newLanguage !== undefined ? { language: rekey.newLanguage } : {}),
            ...(rekey.newMarkdownPreviewSourceFileId !== undefined
              ? { markdownPreviewSourceFileId: rekey.newMarkdownPreviewSourceFileId }
              : {}),
            ...(rekey.consumeUntitled
              ? { isUntitled: undefined, deleteUntouchedOnClose: undefined }
              : {}),
            ...(gatesEcho
              ? {
                  pendingLiveDiskVerification: true,
                  pendingSelfMoveEcho: {
                    operationId: moveOperationId,
                    targetPath: rekey.newFilePath
                  }
                }
              : {})
          }
        })

        return rekeyEditorFileState(s, { rekeys, migrations, nextOpenFiles })
      })
      return result
    }
  }
}

export function rekeyEditorFileState(
  s: AppState,
  {
    rekeys,
    migrations,
    nextOpenFiles,
    discardSourceIds,
    discardDraftIds,
    mergePaneTabs = false
  }: {
    rekeys: readonly OpenFilePathRekey[]
    migrations: ReadonlyMap<string, string>
    nextOpenFiles: OpenFile[]
    discardSourceIds?: ReadonlySet<string>
    discardDraftIds?: ReadonlySet<string>
    mergePaneTabs?: boolean
  }
): Partial<AppState> {
  const rekeyByOldId = new Map(rekeys.map((rekey) => [rekey.oldFileId, rekey]))
  const openById = new Map(s.openFiles.map((file) => [file.id, file]))
  const rekeyViewRecord = <T>(record: Record<string, T>): Record<string, T> =>
    rekeyFileIdRecord(
      discardSourceIds
        ? Object.fromEntries(Object.entries(record).filter(([id]) => !discardSourceIds.has(id)))
        : record,
      migrations
    )
  const activeFileIdByWorktree: Record<string, string | null> = {}
  for (const [wtId, activeId] of Object.entries(s.activeFileIdByWorktree)) {
    activeFileIdByWorktree[wtId] = activeId ? (migrations.get(activeId) ?? activeId) : activeId
  }

  // Partition by each moved file's OWN worktree: the same path can be open in more than one worktree (e.g. a floating workspace), and tab-bar / group state is per-worktree.
  const migrationsByWorktree: Record<string, Map<string, string>> = {}
  for (const rekey of rekeys) {
    const wtId = openById.get(rekey.oldFileId)!.worktreeId
    ;(migrationsByWorktree[wtId] ??= new Map()).set(rekey.oldFileId, rekey.newFileId)
  }

  const tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
  for (const [wtId, wtMigrations] of Object.entries(migrationsByWorktree)) {
    const prevBarOrder = tabBarOrderByWorktree[wtId]
    if (prevBarOrder) {
      const order = prevBarOrder.map((id) => wtMigrations.get(id) ?? id)
      tabBarOrderByWorktree[wtId] = mergePaneTabs ? [...new Set(order)] : order
    }
  }

  const reveal = s.pendingEditorReveal
  const focus = s.pendingEditorFocusRequest
  // Why: two worktrees can rekey the same oldFilePath, so an id-keyed reveal must match its own file, not the first path match.
  const rekeyForReveal = !reveal
    ? undefined
    : reveal.fileId
      ? rekeyByOldId.get(reveal.fileId)
      : rekeys.find((r) => r.oldFilePath === reveal.filePath)

  const migrated = migrateHydratedEditorTabsAndGroups(s, migrationsByWorktree, mergePaneTabs)
  const focusOwner = mergePaneTabs && focus ? openById.get(focus.fileId) : undefined
  const focusedTab =
    focusOwner &&
    focus &&
    s.unifiedTabsByWorktree[focusOwner.worktreeId]?.find((tab) => tab.id === focus.viewStateId)
  const nextFocusedTab =
    focusedTab &&
    (migrated.unifiedTabsByWorktree?.[focusedTab.worktreeId] ?? []).find(
      (tab) =>
        tab.groupId === focusedTab.groupId &&
        tab.entityId === (migrations.get(focusedTab.entityId) ?? focusedTab.entityId)
    )
  return {
    openFiles: nextOpenFiles,
    editorDrafts: rekeyFileIdRecord(
      discardDraftIds
        ? Object.fromEntries(
            Object.entries(s.editorDrafts).filter(([id]) => !discardDraftIds.has(id))
          )
        : s.editorDrafts,
      migrations
    ),
    editorCursorLine: rekeyViewRecord(s.editorCursorLine),
    markdownViewMode: rekeyViewRecord(s.markdownViewMode),
    markdownRichModeSizeOverride: rekeyViewRecord(s.markdownRichModeSizeOverride),
    editorViewMode: rekeyViewRecord(s.editorViewMode),
    markdownFrontmatterVisible: rekeyViewRecord(s.markdownFrontmatterVisible),
    markdownTableOfContentsVisible: rekeyViewRecord(s.markdownTableOfContentsVisible),
    activeFileId: s.activeFileId ? (migrations.get(s.activeFileId) ?? s.activeFileId) : null,
    activeFileIdByWorktree,
    tabBarOrderByWorktree,
    ...migrated,
    ...(mergePaneTabs && focus && migrations.has(focus.fileId)
      ? {
          pendingEditorFocusRequest: {
            ...focus,
            fileId: migrations.get(focus.fileId) ?? focus.fileId,
            viewStateId:
              nextFocusedTab?.id ?? migrations.get(focus.viewStateId) ?? focus.viewStateId
          }
        }
      : {}),
    ...(reveal && rekeyForReveal
      ? {
          pendingEditorReveal: {
            ...reveal,
            filePath: rekeyForReveal.newFilePath,
            // matchesPendingEditorReveal prefers fileId, so migrate it too or
            // the reveal would never match the rekeyed tab.
            ...(reveal.fileId ? { fileId: migrations.get(reveal.fileId) ?? reveal.fileId } : {})
          }
        }
      : {})
  }
}
