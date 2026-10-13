import type * as Monaco from 'monaco-editor'

const policies = new WeakMap<Monaco.editor.IDiffEditor, () => boolean>()
const pending = new Set<Monaco.editor.ITextModel>()
let scheduled = false

export function registerPluginGrammarDiffRefresh(
  diff: Monaco.editor.IDiffEditor,
  renderIndicators: () => boolean
): Monaco.IDisposable {
  policies.set(diff, renderIndicators)
  return { dispose: () => policies.delete(diff) }
}

export function refreshPluginGrammarDiffTokens(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel
): void {
  pending.add(model)
  if (scheduled) {
    return
  }
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const changed = new Set(pending)
    pending.clear()
    for (const diff of monaco.editor.getDiffEditors()) {
      const original = diff.getModel()?.original
      const policy = policies.get(diff)
      if (!original || original.isDisposed() || !changed.has(original) || !policy) {
        continue
      }
      monaco.editor.colorizeModelLine(original, original.getLineCount(), 2)
      const indicators = policy()
      const viewState = diff.saveViewState()
      // Inline deleted lines cache HTML separately from the model's token provider.
      diff.updateOptions({ renderIndicators: !indicators })
      diff.updateOptions({ renderIndicators: indicators })
      if (viewState) {
        diff.restoreViewState(viewState)
      }
    }
  })
}
