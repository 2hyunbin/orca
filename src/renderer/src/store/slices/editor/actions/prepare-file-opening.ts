import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { getPluginFileOpeningPlan } from '@/lib/plugin-file-opening-plan'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { resolvePluginViewerSourceView } from '../../../../../../shared/plugins/plugin-viewer-source-view'

export function prepareFileOpening(
  state: AppState,
  input: Omit<OpenFile, 'id' | 'isDirty'>,
  options?: { fileViewer?: 'core'; suppressActiveRuntimeFallback?: boolean }
): Omit<OpenFile, 'id' | 'isDirty'> {
  if (
    input.mode !== 'edit' ||
    input.readOnly ||
    input.isUntitled ||
    input.conflict ||
    options?.fileViewer === 'core'
  ) {
    return input
  }
  const registry = usePluginFileViewerStore.getState()
  const available = typeof window !== 'undefined' && Boolean(window.api?.plugins?.listFileViewers)
  const plan = getPluginFileOpeningPlan(
    input.filePath,
    state.settings,
    available ? registry : { ...registry, status: 'unsupported' }
  )
  if (plan.kind === 'core') {
    return input
  }
  const sourceView = resolvePluginViewerSourceView(input)
  let provenance = input.operationProvenance
  try {
    provenance ??= captureEditorFileOperationProvenance(
      state,
      input.worktreeId,
      options?.suppressActiveRuntimeFallback ? null : input.runtimeEnvironmentId,
      options?.suppressActiveRuntimeFallback === true || input.runtimeEnvironmentId !== undefined
    )
  } catch {
    // The waiting surface keeps unresolved ownership away from all readers.
  }
  const file = {
    ...input,
    operationProvenance: provenance,
    ...(provenance
      ? { runtimeEnvironmentId: provenance.generation.route.runtimeEnvironmentId }
      : {})
  }
  if (plan.kind === 'plugin' && provenance) {
    return {
      ...file,
      mode: 'plugin-viewer',
      readOnly: true,
      pluginViewer: { key: plan.viewer.key, sourceView }
    }
  }
  return {
    ...file,
    mode: 'file-opening',
    readOnly: true,
    fileOpening: sourceView,
    fileOpeningChoicePending: plan.kind !== 'loading',
    fileOpeningOwnerUnresolved: !provenance
  }
}
