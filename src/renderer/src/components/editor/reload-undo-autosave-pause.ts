import type { editor, IDisposable } from 'monaco-editor'
import { useAppStore } from '@/store'

const watchByModel = new WeakMap<editor.ITextModel, IDisposable>()

/**
 * Pause autosave for the tab whenever undo/redo moves its model to before a banner reload, and
 * resume when it moves back after it. Undone-reload text is the user's choice, but only an explicit
 * save may write it. The boundary lasts until the next reload or model disposal.
 */
export function watchReloadUndoBoundary(model: editor.ITextModel, fileId: string): void {
  watchByModel.get(model)?.dispose()
  useAppStore.getState().setAutosavePausedAfterReloadUndo(fileId, false)
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
    useAppStore.getState().setAutosavePausedAfterReloadUndo(fileId, beforeReload)
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
