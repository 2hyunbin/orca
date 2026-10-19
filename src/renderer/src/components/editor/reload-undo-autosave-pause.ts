import type { editor, IDisposable } from 'monaco-editor'
import { useAppStore } from '@/store'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'

const watchByModel = new WeakMap<editor.ITextModel, IDisposable>()

// Why: one model can back several tabs (the same file in overlapping workspaces); all share its text.
function setPausedForModelTabs(modelKey: string, paused: boolean): void {
  const state = useAppStore.getState()
  const fileIds = state.openFiles
    .filter(
      (file) =>
        file.mode === 'edit' &&
        toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state)) === modelKey
    )
    .map((file) => file.id)
  state.setAutosavePausedAfterReloadUndo(fileIds, paused)
}

/**
 * Pause autosave for every tab on this model whenever undo/redo moves it to before a banner
 * reload, and resume when it moves back after it. Undone-reload text is the user's choice, but
 * only an explicit save may write it. The boundary lasts until the next reload or model disposal.
 */
export function watchReloadUndoBoundary(model: editor.ITextModel, modelKey: string): void {
  watchByModel.get(model)?.dispose()
  setPausedForModelTabs(modelKey, false)
  const afterReloadVersions = new Set([model.getAlternativeVersionId()])
  let beforeReload = false
  const subscription = model.onDidChangeContent((event) => {
    const version = model.getAlternativeVersionId()
    if (!event.isUndoing && !event.isRedoing) {
      if (!beforeReload) {
        afterReloadVersions.add(version)
      }
      return
    }
    const nowBeforeReload = !afterReloadVersions.has(version)
    if (nowBeforeReload === beforeReload) {
      return
    }
    beforeReload = nowBeforeReload
    setPausedForModelTabs(modelKey, beforeReload)
  })
  const willDispose = model.onWillDispose(stop)
  function stop(): void {
    subscription.dispose()
    willDispose.dispose()
    if (watchByModel.get(model)?.dispose === stop) {
      watchByModel.delete(model)
    }
  }
  watchByModel.set(model, { dispose: stop })
}
