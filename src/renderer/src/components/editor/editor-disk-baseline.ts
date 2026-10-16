import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from './diff-content-signature'
import type { FileContent } from './editor-panel-content-types'

// Why: a dirty tab's draft still derives from its older disk baseline.
export function stampCleanTabDiskBaseline(id: string, result: FileContent): void {
  if (result.isBinary || result.loadError || result.csvPreview) {
    return
  }
  try {
    const state = useAppStore.getState()
    const loadedFile = state.openFiles.find((file) => file.id === id)
    if (loadedFile && !loadedFile.isDirty) {
      state.setLastKnownDiskSignature(id, getDiskBaselineSignature(result.content))
    }
  } catch (err) {
    console.warn('[editor] failed to stamp disk baseline', err)
  }
}
