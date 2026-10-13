import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { matchingPluginFileViewers } from '@/lib/plugin-file-opening-plan'
import { fileOpeningTransition } from './file-opening-transition'

export function createResolveFileOpening(
  set: EditorSet,
  _get: EditorGet
): Pick<EditorSlice, 'resolveFileOpening'> {
  return {
    resolveFileOpening: (fileId, viewerKey) => {
      let resolved = false
      set((state) => {
        const file = state.openFiles.find(
          (item) => item.id === fileId && item.mode === 'file-opening'
        )
        if (
          !file ||
          file.fileOpeningOwnerUnresolved ||
          (viewerKey === 'core' && file.pluginViewerUserSelectedFile)
        ) {
          return state
        }
        const registry = usePluginFileViewerStore.getState()
        if (
          viewerKey !== 'core' &&
          (registry.status !== 'ready' ||
            !matchingPluginFileViewers(registry, file.filePath).some(
              (viewer) => viewer.key === viewerKey
            ))
        ) {
          return state
        }
        try {
          const provenance =
            file.operationProvenance ??
            captureEditorFileOperationProvenance(
              state,
              file.worktreeId,
              file.runtimeEnvironmentId,
              file.runtimeEnvironmentId !== undefined
            )
          assertEditorFileOperationCurrent(state, file.worktreeId, provenance)
          resolved = true
          return fileOpeningTransition(
            state,
            { ...file, operationProvenance: provenance },
            viewerKey
          )
        } catch {
          return state
        }
      })
      return resolved
    }
  }
}
