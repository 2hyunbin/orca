import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isSameEditorOwner, resolveEditorFileIdForOwner } from '../file-ids/editor-file-ids'
import { pluginViewerFileId } from '../file-ids/plugin-viewer-file-id'
import { rekeyEditorFileState } from './rekey-open-files-action'
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
  const nextOpenFiles = state.openFiles.flatMap((candidate) =>
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
  )
  return rekeyEditorFileState(state, {
    rekeys: [
      {
        oldFileId: file.id,
        newFileId: nextId,
        oldFilePath: file.filePath,
        newFilePath: file.filePath,
        newRelativePath: file.relativePath
      }
    ],
    migrations: new Map([[file.id, nextId]]),
    nextOpenFiles,
    discardSourceIds: existing ? new Set([file.id]) : undefined,
    discardDraftIds: new Set([file.id]),
    mergePaneTabs: true
  })
}
