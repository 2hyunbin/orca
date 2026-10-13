import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { assertEditorFileOperationCurrent } from '@/lib/editor-file-operation-owner'

export function pluginViewerReopenState(
  state: AppState,
  existing: OpenFile,
  incoming: Omit<OpenFile, 'id' | 'isDirty'>
):
  | Pick<OpenFile, 'operationProvenance' | 'fileContentReloadNonce' | 'pluginViewerOwnerExpired'>
  | undefined {
  if (
    existing.mode !== 'plugin-viewer' ||
    incoming.mode !== 'plugin-viewer' ||
    existing.pluginViewer?.key !== incoming.pluginViewer?.key ||
    !incoming.operationProvenance
  ) {
    return
  }
  try {
    assertEditorFileOperationCurrent(state, incoming.worktreeId, incoming.operationProvenance)
  } catch {
    return
  }
  if (existing.operationProvenance && !existing.pluginViewerOwnerExpired) {
    try {
      assertEditorFileOperationCurrent(state, existing.worktreeId, existing.operationProvenance)
      return
    } catch {
      // A deliberate, verified reopen replaces the expired session's authority.
    }
  }
  return {
    operationProvenance: incoming.operationProvenance,
    pluginViewerOwnerExpired: undefined,
    fileContentReloadNonce: (existing.fileContentReloadNonce ?? 0) + 1
  }
}
