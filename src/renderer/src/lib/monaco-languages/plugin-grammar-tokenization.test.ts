import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as oniguruma from 'vscode-oniguruma'
import type { IOnigLib } from 'shiki/textmate'
import { textmateOnigurumaLibrary } from '../syntax-highlighting/textmate-core'
import {
  isValidPluginGrammarTokenData,
  type PluginGrammarRequest
} from '../../../../shared/plugins/plugin-grammar-protocol'
import {
  pluginGrammarTokenType,
  tokenizePluginGrammarDocument
} from './plugin-grammar-tokenization'
import typstGrammar from './textmate-grammars/typst.tmLanguage.json'

let onigLib: Promise<IOnigLib> | undefined
function engine(): Promise<IOnigLib> {
  onigLib ??= (async () => {
    const bytes = await readFile(
      createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm')
    )
    await oniguruma.loadWASM(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
    return textmateOnigurumaLibrary(oniguruma)
  })()
  return onigLib
}

function request(text: string): PluginGrammarRequest {
  return {
    id: 1,
    generation: 1,
    version: 1,
    scopeName: 'source.typst',
    text,
    grammars: [{ scopeName: 'source.typst', content: JSON.stringify(typstGrammar) }]
  }
}

function decode(data: Uint32Array) {
  const tokens: { line: number; start: number; length: number; type: number }[] = []
  let line = 0
  let start = 0
  for (let offset = 0; offset < data.length; offset += 5) {
    line += data[offset]
    start = data[offset] === 0 ? start + data[offset + 1] : data[offset + 1]
    tokens.push({ line, start, length: data[offset + 2], type: data[offset + 3] })
  }
  return tokens
}

describe('worker document grammar evaluation', () => {
  it('preserves multiline comment, math, and raw-block states with a real bundled grammar', async () => {
    const text = [
      '/* outer',
      '/* inner */ still outer',
      '*/',
      '#let after = 12pt',
      '$',
      'x + y',
      '$',
      '```rust',
      'let x = 1',
      '```',
      '#let width = 2pt'
    ].join('\n')
    const data = await tokenizePluginGrammarDocument(request(text), engine(), () => {})
    expect(data).not.toBeNull()
    if (!data) {
      throw new Error('No tokens')
    }
    expect(isValidPluginGrammarTokenData(data, text)).toBe(true)
    const tokens = decode(data)
    expect(tokens.filter((token) => token.line === 1).every((token) => token.type === 0)).toBe(true)
    expect(tokens).toContainEqual({ line: 3, start: 1, length: 3, type: 2 })
    expect(tokens.filter((token) => token.line === 5).every((token) => token.type === 1)).toBe(true)
    expect(tokens).toContainEqual({ line: 8, start: 0, length: 9, type: 1 })
    expect(tokens).toContainEqual({ line: 10, start: 1, length: 3, type: 2 })
  })

  it('changes subsequent lines after removing an opening delimiter', async () => {
    const before = await tokenizePluginGrammarDocument(
      request('/*\n#let width = 12pt'),
      engine(),
      () => {}
    )
    const after = await tokenizePluginGrammarDocument(
      request('\n#let width = 12pt'),
      engine(),
      () => {}
    )
    if (!before || !after) {
      throw new Error('No tokens')
    }
    expect(
      decode(before)
        .filter((token) => token.line === 1)
        .every((token) => token.type === 0)
    ).toBe(true)
    expect(decode(after)).toContainEqual({ line: 1, start: 1, length: 3, type: 2 })
  })

  it('rejects huge document snapshots before initializing grammar evaluation', async () => {
    await expect(
      tokenizePluginGrammarDocument(request('x'.repeat(500_001)), engine(), () => {})
    ).resolves.toBeNull()
    await expect(
      tokenizePluginGrammarDocument(request('\n'.repeat(20_000)), engine(), () => {})
    ).resolves.toBeNull()
  })

  it('maps nested scopes to standard theme token classes without hiding outer comments', () => {
    expect(
      pluginGrammarTokenType([
        'source.typst',
        'comment.block.typst',
        'punctuation.definition.comment'
      ])
    ).toBe(0)
    expect(pluginGrammarTokenType(['source.typst', 'keyword.operator.arithmetic'])).toBe(7)
    expect(pluginGrammarTokenType(['source.typst', 'unknown.scope'])).toBeNull()
  })

  it.each([
    [0, 0, 2, 2, 0],
    [1, 0, 1, 2, 0],
    [0, 0, 0, 2, 0],
    [0, 0, 1, 8, 0],
    [0, 0, 1, 2, 1],
    [0, 0, 1, 2],
    [0, 0, 1, 2, 0, 0, 0, 1, 2, 0]
  ])('rejects malformed or overlapping semantic tokens %j', (...values) => {
    expect(isValidPluginGrammarTokenData(new Uint32Array(values), 'x')).toBe(false)
  })
})
