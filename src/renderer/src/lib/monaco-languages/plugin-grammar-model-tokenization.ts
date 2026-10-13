import type * as Monaco from 'monaco-editor'
import {
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
} from '../../../../shared/plugins/plugin-grammar-protocol'
import type { PluginGrammarWorkerClient } from './plugin-grammar-worker-client'
import { PluginGrammarFailure, type PluginGrammarFailureReason } from './plugin-grammar-failure'

export function createPluginGrammarModelTokenizer(
  client: Pick<PluginGrammarWorkerClient, 'tokenize' | 'dispose'>,
  generation: number,
  onAccepted: (model: Monaco.editor.ITextModel, text: string, data: Uint32Array) => void,
  onFailed?: (model: Monaco.editor.ITextModel, reason: PluginGrammarFailureReason) => void
): {
  tokenize: (model: Monaco.editor.ITextModel) => Promise<Uint32Array | null>
  cancel: (model: Monaco.editor.ITextModel) => void
  dispose: () => void
} {
  let disposed = false
  const requests = new Map<Monaco.editor.ITextModel, AbortController>()
  return {
    cancel(model) {
      requests.get(model)?.abort()
      requests.delete(model)
    },
    async tokenize(model) {
      if (disposed || model.isDisposed()) {
        return null
      }
      requests.get(model)?.abort()
      requests.delete(model)
      if (
        model.getValueLength() > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT ||
        model.getLineCount() > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
      ) {
        onFailed?.(model, 'size')
        return null
      }
      const controller = new AbortController()
      requests.set(model, controller)
      const version = model.getVersionId()
      const removal = model.onWillDispose(() => controller.abort())
      const change = model.onDidChangeContent(() => controller.abort())
      try {
        const text = model.getValue()
        const data = await client.tokenize(text, version, generation, controller.signal)
        if (
          !data ||
          disposed ||
          controller.signal.aborted ||
          model.isDisposed() ||
          model.getVersionId() !== version
        ) {
          return null
        }
        onAccepted(model, text, data)
        return data
      } catch (error: unknown) {
        if (
          !disposed &&
          !controller.signal.aborted &&
          !model.isDisposed() &&
          model.getVersionId() === version
        ) {
          onFailed?.(model, error instanceof PluginGrammarFailure ? error.reason : 'worker')
        }
        return null
      } finally {
        removal.dispose()
        change.dispose()
        if (requests.get(model) === controller) {
          requests.delete(model)
        }
      }
    },
    dispose: () => {
      disposed = true
      for (const controller of requests.values()) {
        controller.abort()
      }
      requests.clear()
      client.dispose()
    }
  }
}
