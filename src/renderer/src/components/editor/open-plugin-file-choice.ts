import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { matchingPluginFileViewers } from '@/lib/plugin-file-opening-plan'
import {
  captureEditorFileOperationProvenance,
  assertEditorFileOperationCurrent
} from '@/lib/editor-file-operation-owner'
import { resolvePluginViewerSourceView } from '../../../../shared/plugins/plugin-viewer-source-view'
import type { PluginViewerAssociationSelector } from '../../../../shared/plugins/plugin-viewer-associations'
import { updatePluginViewerAssociation } from '@/store/update-plugin-viewer-association'

export async function openPluginFileChoice(
  file: OpenFile,
  viewerKey: string,
  selector?: PluginViewerAssociationSelector | null,
  viewStateId?: string,
  signal?: AbortSignal
): Promise<void> {
  if (
    file.fileOpeningOwnerUnresolved ||
    signal?.aborted ||
    (viewerKey === 'core' && file.pluginViewerUserSelectedFile)
  ) {
    throw new Error('source owner changed')
  }
  const initial = useAppStore.getState()
  const provenance =
    file.operationProvenance ??
    captureEditorFileOperationProvenance(
      initial,
      file.worktreeId,
      file.runtimeEnvironmentId,
      file.runtimeEnvironmentId !== undefined
    )
  assertEditorFileOperationCurrent(initial, file.worktreeId, provenance)
  if (!initial.openFiles.some((item) => item.id === file.id && item.mode === file.mode)) {
    throw new Error('source closed')
  }
  assertViewerAvailable(file.filePath, viewerKey)
  if (selector) {
    await updatePluginViewerAssociation(selector, viewerKey, signal)
  }
  const state = useAppStore.getState()
  if (signal?.aborted) {
    throw new Error('source closed')
  }
  const current = state.openFiles.find((item) => item.id === file.id)
  const route = assertEditorFileOperationCurrent(state, file.worktreeId, provenance)
  if (
    !current ||
    current.mode !== file.mode ||
    (viewerKey === 'core' && current.pluginViewerUserSelectedFile)
  ) {
    throw new Error('source closed')
  }
  assertViewerAvailable(file.filePath, viewerKey)
  const groupId = viewStateId
    ? state.unifiedTabsByWorktree[file.worktreeId]?.find((tab) => tab.id === viewStateId)?.groupId
    : undefined
  if (viewStateId && !groupId) {
    throw new Error('source pane closed')
  }
  if (current.mode === 'file-opening') {
    if (!state.resolveFileOpening(current.id, viewerKey)) {
      throw new Error('source owner changed')
    }
    return
  }
  const sourceView = resolvePluginViewerSourceView(current)
  state.openFile(
    {
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      runtimeEnvironmentId: route.runtimeEnvironmentId,
      externalSshTargetId: file.externalSshTargetId,
      operationProvenance: provenance,
      pluginViewerUserSelectedFile: file.pluginViewerUserSelectedFile,
      mode: viewerKey === 'core' ? 'edit' : 'plugin-viewer',
      ...(viewerKey === 'core'
        ? { readOnly: sourceView.readOnly || undefined, liveTail: sourceView.liveTail }
        : { readOnly: true, pluginViewer: { key: viewerKey, sourceView } })
    },
    { preview: false, fileViewer: 'core', ...(groupId ? { targetGroupId: groupId } : {}) }
  )
}

function assertViewerAvailable(filePath: string, viewerKey: string): void {
  if (viewerKey === 'core') {
    return
  }
  const registry = usePluginFileViewerStore.getState()
  if (
    registry.status !== 'ready' ||
    !matchingPluginFileViewers(registry, filePath).some((item) => item.key === viewerKey)
  ) {
    throw new Error('viewer unavailable')
  }
}
