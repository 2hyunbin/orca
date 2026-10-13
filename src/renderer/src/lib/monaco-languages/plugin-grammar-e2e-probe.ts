import type * as Monaco from 'monaco-editor'
import PluginGrammarWorker from './plugin-grammar.worker?worker'
import { PluginGrammarWorkerClient } from './plugin-grammar-worker-client'
import { createPluginGrammarModelTokenizer } from './plugin-grammar-model-tokenization'
import { PluginGrammarTokenCache } from './plugin-grammar-token-cache'
import type { PluginGrammarSource } from '../../../../shared/plugins/plugin-grammar-protocol'

export type PluginGrammarE2EProbe = {
  configure: (scopeName: string, grammars: PluginGrammarSource[]) => void
  modelValues: () => { language: string; value: string; readOnly: boolean }[]
  replace: (value: string) => void
  dispose: () => void
  diagnostics: () => {
    startedWorkers: number
    timedOutWorkers: number
    completedDocuments: number
  } | null
}

export function installPluginGrammarE2EProbe(monaco: typeof Monaco): void {
  if (import.meta.env.MODE !== 'e2e') {
    return
  }
  let generation = 0
  let cleanup: (() => void) | undefined
  let activeClient: PluginGrammarWorkerClient | undefined
  const probe: PluginGrammarE2EProbe = {
    configure: (scopeName, grammars) => {
      cleanup?.()
      const language = `orca-grammar-probe-${++generation}`
      monaco.languages.register({ id: language })
      const client = new PluginGrammarWorkerClient(
        scopeName,
        grammars,
        () => new PluginGrammarWorker()
      )
      activeClient = client
      const cache = new PluginGrammarTokenCache()
      let tokens = monaco.languages.setTokensProvider(language, cache.provider)
      const bridge = createPluginGrammarModelTokenizer(client, generation, (model, text, data) => {
        if (cache.add(text, data)) {
          tokens.dispose()
          tokens = monaco.languages.setTokensProvider(language, cache.provider)
          monaco.editor.colorizeModelLine(model, model.getLineCount(), 2)
          for (const diff of monaco.editor.getDiffEditors()) {
            if (diff.getModel()?.original === model) {
              const state = diff.saveViewState()
              // Inline deleted-line HTML needs a public view refresh after cached tokens change.
              diff.updateOptions({ renderIndicators: false })
              diff.updateOptions({ renderIndicators: true })
              if (state) {
                diff.restoreViewState(state)
              }
            }
          }
        }
      })
      const originalModels = new Map<Monaco.editor.ITextModel, string>()
      const modelChanges: Monaco.IDisposable[] = []
      const warm = (model: Monaco.editor.ITextModel): void => {
        void bridge.tokenize(model).catch(() => {})
      }
      for (const editor of monaco.editor.getEditors()) {
        const model = editor.getModel()
        if (!model || model.isDisposed()) {
          continue
        }
        originalModels.set(model, model.getLanguageId())
        monaco.editor.setModelLanguage(model, language)
        modelChanges.push(model.onDidChangeContent(() => warm(model)))
        warm(model)
      }
      cleanup = () => {
        bridge.dispose()
        for (const listener of modelChanges) {
          listener.dispose()
        }
        tokens.dispose()
        for (const [model, originalLanguage] of originalModels) {
          if (!model.isDisposed()) {
            monaco.editor.setModelLanguage(model, originalLanguage)
          }
        }
      }
    },
    diagnostics: () => activeClient?.diagnostics() ?? null,
    modelValues: () =>
      monaco.editor.getEditors().flatMap((editor) => {
        const model = editor.getModel()
        return model
          ? [
              {
                language: model.getLanguageId(),
                value: model.getValue(),
                readOnly: editor.getOption(monaco.editor.EditorOption.readOnly)
              }
            ]
          : []
      }),
    replace: (value) => {
      const editor =
        monaco.editor
          .getEditors()
          .find((candidate) =>
            candidate.getModel()?.getLanguageId().startsWith('orca-grammar-probe-')
          ) ?? monaco.editor.getEditors().find((candidate) => candidate.getModel())
      if (!editor) {
        throw new Error('Grammar probe model unavailable')
      }
      editor.setValue(value)
    },
    dispose: () => {
      cleanup?.()
      cleanup = undefined
    }
  }
  window.__pluginGrammarE2E = probe
}
