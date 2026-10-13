import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext,
  type EditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'

export function pluginViewerReloadProvenance(
  state: AppState,
  file: OpenFile
): EditorFileOperationProvenance {
  const previous = file.operationProvenance
  const next = captureEditorFileOperationProvenance(
    state,
    file.worktreeId,
    file.runtimeEnvironmentId,
    file.runtimeEnvironmentId !== undefined
  )
  const environmentId = next.generation.route.runtimeEnvironmentId
  if (
    (!previous && file.pluginViewerOwnerExpired) ||
    (previous &&
      JSON.stringify(previous.generation.route) !== JSON.stringify(next.generation.route)) ||
    (previous &&
      environmentId &&
      (previous.generation.runtimePairingRevision === undefined ||
        resolveContinuedRuntimeEnvironmentRevision(
          environmentId,
          previous.generation.runtimePairingRevision
        ) !== next.generation.runtimePairingRevision))
  ) {
    throw new Error('The file owner changed. Reopen the file from its workspace.')
  }
  getEditorFileOperationContext(state, { ...file, operationProvenance: next }, null)
  return next
}
