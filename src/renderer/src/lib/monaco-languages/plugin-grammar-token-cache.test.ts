import { describe, expect, it } from 'vitest'
import { PluginGrammarTokenCache } from './plugin-grammar-token-cache'

describe('worker-prepared synchronous token cache', () => {
  it('rejects state from a replaced grammar or another package', () => {
    const before = new PluginGrammarTokenCache()
    before.add('open\nbody', new Uint32Array([1, 0, 4, 0, 0]))
    const old = before.provider.tokenize('open', before.provider.getInitialState()).endState
    const after = new PluginGrammarTokenCache()
    after.add('open\nbody', new Uint32Array([1, 0, 4, 2, 0]))
    expect(after.provider.tokenize('body', old).tokens).toEqual([{ startIndex: 0, scopes: '' }])
    const fresh = after.provider.tokenize('open', after.provider.getInitialState()).endState
    expect(after.provider.tokenize('body', fresh).tokens[0].scopes).toBe('keyword')
  })
  it('separates identical lines after different prefixes', () => {
    const cache = new PluginGrammarTokenCache()
    cache.add('open\nbody', new Uint32Array([1, 0, 4, 0, 0]))
    cache.add('closed\nbody', new Uint32Array([1, 0, 4, 2, 0]))
    const provider = cache.provider
    const initial = provider.getInitialState()
    const inComment = provider.tokenize('open', initial).endState
    const inCode = provider.tokenize('closed', initial).endState
    expect(inComment.equals(inCode)).toBe(false)
    expect(provider.tokenize('body', inComment).tokens[0].scopes).toBe('comment')
    expect(provider.tokenize('body', inCode).tokens[0].scopes).toBe('keyword')
  })

  it('returns plain text for a changed uncached prefix until worker results arrive', () => {
    const cache = new PluginGrammarTokenCache()
    const provider = cache.provider
    cache.add('/*\nbody', new Uint32Array([1, 0, 4, 0, 0]))
    const before = provider.tokenize('/*', provider.getInitialState()).endState
    expect(provider.tokenize('body', before).tokens[0].scopes).toBe('comment')
    const unknown = provider.tokenize('changed', provider.getInitialState()).endState
    expect(provider.tokenize('body', unknown).tokens).toEqual([{ startIndex: 0, scopes: '' }])
    cache.add('changed\nbody', new Uint32Array([1, 0, 4, 2, 0]))
    const after = provider.tokenize('changed', provider.getInitialState()).endState
    expect(provider.tokenize('body', after).tokens[0].scopes).toBe('keyword')
  })

  it('reuses shared prefixes without appending duplicate token ranges', () => {
    const cache = new PluginGrammarTokenCache()
    const data = new Uint32Array([0, 0, 3, 2, 0, 0, 4, 1, 3, 0])
    cache.add('let 2', data)
    cache.add('let 2\nnext', data)
    cache.add('let 2', data)
    expect(cache.provider.tokenize('let 2', cache.provider.getInitialState()).tokens).toEqual([
      { startIndex: 0, scopes: 'keyword' },
      { startIndex: 3, scopes: '' },
      { startIndex: 4, scopes: 'number' },
      { startIndex: 5, scopes: '' }
    ])
  })

  it('invalidates old prefix states when the bounded cache is replaced', () => {
    const cache = new PluginGrammarTokenCache()
    const provider = cache.provider
    const text = `${'a'.repeat(499_995)}\nnext`
    cache.add(text, new Uint32Array([1, 0, 4, 2, 0]))
    const old = provider.tokenize('a'.repeat(499_995), provider.getInitialState()).endState
    for (const prefix of ['b', 'c', 'd', 'e']) {
      cache.add(`${prefix.repeat(499_995)}\nnext`, new Uint32Array([1, 0, 4, 0, 0]))
    }
    expect(provider.tokenize('next', old).tokens).toEqual([{ startIndex: 0, scopes: '' }])
    const fresh = provider.tokenize('e'.repeat(499_995), provider.getInitialState()).endState
    expect(provider.tokenize('next', fresh).tokens[0].scopes).toBe('comment')
  })

  it('rejects malformed worker ranges before caching any tokens', () => {
    const cache = new PluginGrammarTokenCache()
    expect(cache.add('x', new Uint32Array([0, 0, 2, 2, 0]))).toBe(false)
    expect(cache.provider.tokenize('x', cache.provider.getInitialState()).tokens).toEqual([
      { startIndex: 0, scopes: '' }
    ])
  })
})
