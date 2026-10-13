import type * as Monaco from 'monaco-editor'
import {
  PLUGIN_GRAMMAR_TOKEN_TYPES,
  PLUGIN_GRAMMAR_CACHE_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_CACHE_LINE_LIMIT,
  isValidPluginGrammarTokenData
} from '../../../../shared/plugins/plugin-grammar-protocol'

type PrefixNode = { children: Map<string, PrefixNode>; tokens: Monaco.languages.IToken[] }

function node(): PrefixNode {
  return { children: new Map(), tokens: [{ startIndex: 0, scopes: '' }] }
}

class PrefixState implements Monaco.languages.IState {
  constructor(
    readonly prefix: WeakRef<PrefixNode> | null,
    readonly epoch: number,
    readonly owner: symbol
  ) {}
  clone(): PrefixState {
    return this
  }
  equals(other: Monaco.languages.IState): boolean {
    return (
      other instanceof PrefixState &&
      other.owner === this.owner &&
      other.epoch === this.epoch &&
      other.prefix?.deref() === this.prefix?.deref()
    )
  }
}

export class PluginGrammarTokenCache {
  private root = node()
  private readonly identity = Symbol()
  private epoch = 0
  private characters = 0
  private lineCount = 0

  readonly provider: Monaco.languages.TokensProvider = {
    getInitialState: () => new PrefixState(new WeakRef(this.root), this.epoch, this.identity),
    tokenize: (line, state) => {
      const prefix =
        state instanceof PrefixState && state.owner === this.identity
          ? state.epoch === this.epoch
            ? state.prefix?.deref()?.children.get(line)
            : undefined
          : undefined
      return {
        tokens: prefix?.tokens ?? [{ startIndex: 0, scopes: '' }],
        endState: new PrefixState(prefix ? new WeakRef(prefix) : null, this.epoch, this.identity)
      }
    }
  }

  add(text: string, data: Uint32Array): boolean {
    if (!isValidPluginGrammarTokenData(data, text)) {
      return false
    }
    const lines = text.split(/\r\n|\r|\n/)
    if (
      text.length > PLUGIN_GRAMMAR_CACHE_CHARACTER_LIMIT ||
      lines.length > PLUGIN_GRAMMAR_CACHE_LINE_LIMIT
    ) {
      return false
    }
    if (
      this.characters + text.length > PLUGIN_GRAMMAR_CACHE_CHARACTER_LIMIT ||
      this.lineCount + lines.length > PLUGIN_GRAMMAR_CACHE_LINE_LIMIT
    ) {
      this.epoch++
      this.root = node()
      this.characters = 0
      this.lineCount = 0
    }
    const nodes: PrefixNode[] = []
    let prefix = this.root
    for (const line of lines) {
      let next = prefix.children.get(line)
      if (!next) {
        next = node()
        prefix.children.set(line, next)
        this.characters += line.length
        this.lineCount++
      }
      prefix = next
      next.tokens = [{ startIndex: 0, scopes: '' }]
      nodes.push(next)
    }
    let line = 0
    let start = 0
    for (let offset = 0; offset < data.length; offset += 5) {
      line += data[offset]
      start = data[offset] === 0 ? start + data[offset + 1] : data[offset + 1]
      const tokens = nodes[line].tokens
      const token = { startIndex: start, scopes: PLUGIN_GRAMMAR_TOKEN_TYPES[data[offset + 3]] }
      if (tokens.at(-1)?.startIndex === start) {
        tokens.pop()
      }
      tokens.push(token)
      tokens.push({ startIndex: start + data[offset + 2], scopes: '' })
    }
    return true
  }
}
