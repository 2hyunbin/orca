import { INITIAL, Registry } from 'shiki/textmate'
import type { IOnigLib, StateStack } from 'shiki/textmate'
import { pluginGrammarEngineArtifact } from './plugin-grammar-engine-artifact'
import {
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT,
  PLUGIN_GRAMMAR_TOKEN_LIMIT,
  PLUGIN_GRAMMAR_WORK_SLICE_MS,
  type PluginGrammarRequest
} from '../../../../shared/plugins/plugin-grammar-protocol'

export function pluginGrammarTokenType(scopes: readonly string[]): number | null {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index]
    const type = scope.split('.')[0]
    if (type === 'comment') {
      return 0
    }
    if (type === 'string' || scope.startsWith('markup.raw')) {
      return 1
    }
    if (scope.startsWith('keyword.operator')) {
      return 7
    }
    if (type === 'keyword' || type === 'storage') {
      return 2
    }
    if (scope.startsWith('constant.numeric')) {
      return 3
    }
    if (scope.startsWith('entity.name.type') || scope.startsWith('support.type')) {
      return 4
    }
    if (scope.startsWith('entity.name.function') || scope.startsWith('support.function')) {
      return 5
    }
    if (type === 'variable') {
      return 6
    }
  }
  return null
}

export async function tokenizePluginGrammarDocument(
  request: PluginGrammarRequest,
  onigLib: Promise<IOnigLib>,
  progress: () => void,
  yieldSlice: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))
): Promise<Uint32Array<ArrayBuffer> | null> {
  if (request.text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT) {
    return null
  }
  const lines = request.text.split(/\r\n|\r|\n/)
  if (lines.length > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT) {
    return null
  }
  const sources = new Map(request.grammars.map((source) => [source.scopeName, source.content]))
  const registry = new Registry({
    onigLib: await onigLib,
    loadGrammar: (scopeName) => {
      const content = sources.get(scopeName)
      return content === undefined ? null : pluginGrammarEngineArtifact(content, scopeName)
    }
  })
  try {
    progress()
    const grammar = registry.loadGrammar(request.scopeName)
    if (!grammar) {
      return null
    }
    let state: StateStack = INITIAL
    let previousLine = 0
    let previousStart = 0
    let sliceStart = performance.now()
    const encoded: number[] = []
    for (let line = 0; line < lines.length; line++) {
      const result = grammar.tokenizeLine(lines[line], state, PLUGIN_GRAMMAR_WORK_SLICE_MS)
      if (result.stoppedEarly) {
        return null
      }
      state = result.ruleStack
      for (const token of result.tokens) {
        const type = pluginGrammarTokenType(token.scopes)
        const length = Math.min(token.endIndex, lines[line].length) - token.startIndex
        if (type === null || length <= 0) {
          continue
        }
        encoded.push(
          line - previousLine,
          line === previousLine ? token.startIndex - previousStart : token.startIndex,
          length,
          type,
          0
        )
        if (encoded.length > PLUGIN_GRAMMAR_TOKEN_LIMIT * 5) {
          return null
        }
        previousLine = line
        previousStart = token.startIndex
      }
      if (performance.now() - sliceStart >= PLUGIN_GRAMMAR_WORK_SLICE_MS) {
        progress()
        await yieldSlice()
        sliceStart = performance.now()
      }
    }
    return new Uint32Array(encoded)
  } finally {
    registry.dispose()
  }
}
