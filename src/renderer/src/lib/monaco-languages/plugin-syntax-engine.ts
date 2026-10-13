import type * as Monaco from 'monaco-editor'
import type { PluginSyntaxPackPayload } from '../../../../shared/plugins/plugin-syntax-pack'
import PluginGrammarWorker from './plugin-grammar.worker?worker'
import { PluginGrammarWorkerClient } from './plugin-grammar-worker-client'
import { createPluginGrammarModelTokenizer } from './plugin-grammar-model-tokenization'
import { PluginGrammarTokenCache } from './plugin-grammar-token-cache'
import type { PluginGrammarTaskScheduler } from './plugin-grammar-task-scheduler'
import type { PluginSyntaxSlot } from './plugin-syntax-slot-pool'
import { refreshPluginGrammarDiffTokens } from './plugin-grammar-diff-refresh'
import { PluginGrammarFailure, type PluginGrammarFailureReason } from './plugin-grammar-failure'

export type PluginSyntaxEngine = {
  slot: PluginSyntaxSlot
  warm: (model: Monaco.editor.ITextModel) => void
  retry: (model: Monaco.editor.ITextModel) => void
  cancel: (model: Monaco.editor.ITextModel) => void
  dispose: () => void
}

export function createPluginSyntaxEngine(options: {
  monaco: typeof Monaco
  slot: PluginSyntaxSlot
  generation: number
  scheduler: PluginGrammarTaskScheduler
  load: () => Promise<PluginSyntaxPackPayload | null>
  current: () => boolean
  onFailure: (model: Monaco.editor.ITextModel, reason?: PluginGrammarFailureReason) => void
}): PluginSyntaxEngine {
  const { monaco, slot, scheduler, onFailure } = options
  const controller = new AbortController()
  const cache = new PluginGrammarTokenCache()
  let tokens = monaco.languages.setTokensProvider(slot.id, cache.provider)
  let configuration: Monaco.IDisposable | undefined
  let tokenizer: ReturnType<typeof createPluginGrammarModelTokenizer> | undefined
  let loading = false
  let loadFailed = false
  const pendingModels = new Set<Monaco.editor.ITextModel>()
  const current = () => !controller.signal.aborted && options.current()

  const initialize = async () => {
    if (loading || tokenizer || !current()) {
      return
    }
    loading = true
    loadFailed = false
    try {
      const pack = await options.load()
      const language = pack?.languages.find((item) => item.key === slot.key)
      if (!current()) {
        return
      }
      if (!pack || !language) {
        throw new PluginGrammarFailure('load')
      }
      configuration = monaco.languages.setLanguageConfiguration(slot.id, language.configuration)
      const client = new PluginGrammarWorkerClient(
        language.scopeName,
        pack.grammars,
        () => new PluginGrammarWorker()
      )
      tokenizer = createPluginGrammarModelTokenizer(
        {
          tokenize: async (text, version, generation, signal) => {
            let failure: PluginGrammarFailureReason | undefined
            const data = await scheduler.schedule(
              client,
              signal,
              async () => {
                try {
                  return await client.tokenizeChecked(text, version, generation, signal)
                } finally {
                  client.releaseIdleWorker()
                }
              },
              (reason) => {
                failure = reason
              }
            )
            if (failure) {
              throw new PluginGrammarFailure(failure)
            }
            return data
          },
          dispose: () => client.dispose()
        },
        options.generation,
        (model, text, data) => {
          if (current() && model.getLanguageId() === slot.id) {
            if (!cache.add(text, data)) {
              onFailure(model, 'capacity')
              return
            }
            tokens.dispose()
            tokens = monaco.languages.setTokensProvider(slot.id, cache.provider)
            refreshPluginGrammarDiffTokens(monaco, model)
            onFailure(model)
          }
        },
        (model, reason) => {
          if (current()) {
            onFailure(model, reason)
          }
        }
      )
      for (const model of pendingModels) {
        if (!model.isDisposed()) {
          engine.warm(model)
        }
      }
    } catch {
      if (current()) {
        loadFailed = true
        for (const model of pendingModels) {
          onFailure(model, 'load')
        }
      }
    } finally {
      loading = false
      pendingModels.clear()
    }
  }
  const engine: PluginSyntaxEngine = {
    slot,
    warm: (model) => {
      if (current() && model.getLanguageId() === slot.id) {
        if (tokenizer) {
          void tokenizer.tokenize(model)
        } else if (loadFailed) {
          onFailure(model, 'load')
        } else {
          pendingModels.add(model)
        }
      }
    },
    retry: (model) => {
      if (loadFailed) {
        pendingModels.add(model)
        void initialize()
      } else {
        engine.warm(model)
      }
    },
    cancel: (model) => {
      pendingModels.delete(model)
      tokenizer?.cancel(model)
    },
    dispose: () => {
      controller.abort()
      pendingModels.clear()
      tokenizer?.dispose()
      configuration?.dispose()
      tokens.dispose()
    }
  }
  void initialize()
  return engine
}
