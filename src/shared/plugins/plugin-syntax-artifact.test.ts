import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginManifest, pluginManifestV1Schema } from './plugin-manifest'
import {
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration,
  validatePluginGrammarIncludes
} from './plugin-syntax-artifact'
import { pluginSyntaxPackMetadataSchema, pluginSyntaxPackPayloadSchema } from './plugin-syntax-pack'
import { PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES } from './plugin-syntax-contributions'

const language = { id: 'sample', extensions: ['.sample'], configuration: 'configuration.json' }
const grammar = { language: 'sample', scopeName: 'source.sample', path: 'sample.json' }
const manifest = {
  manifestVersion: 2,
  execution: 'data',
  id: 'syntax-sample',
  publisher: 'community',
  name: 'Sample syntax',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { languages: [language], grammars: [grammar] }
}
const pack = {
  pluginKey: 'community.syntax-sample',
  name: 'Sample syntax',
  revision: 'revision-1',
  languages: [
    {
      id: 'sample',
      key: 'syntax:community.syntax-sample/sample',
      scopeName: 'source.sample',
      extensions: ['.sample']
    }
  ]
}
const parse = (value: unknown) => parsePluginGrammarArtifact(JSON.stringify(value), 'source.sample')

describe('data-only syntax declarations and artifacts', () => {
  it('accepts v2 data syntax and fails closed in the legacy manifest parser', () => {
    expect(parsePluginManifest(manifest).ok).toBe(true)
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(false)
    expect(parsePluginManifest({ ...manifest, manifestVersion: 1, execution: undefined }).ok).toBe(
      false
    )
  })

  it.each([
    { languages: [{ ...language, extensions: ['.sample', '.SAMPLE'] }], grammars: [grammar] },
    { languages: [language, language], grammars: [grammar] },
    { languages: [language], grammars: [grammar, grammar] },
    { languages: [language], grammars: [] },
    { languages: [], grammars: [grammar] },
    { languages: [{ ...language, filenames: ['../Samplefile'] }], grammars: [grammar] },
    { languages: [{ ...language, configuration: '../configuration.json' }], grammars: [grammar] },
    { languages: [{ ...language, tokenizer: 'code.js' }], grammars: [grammar] },
    { languages: [language], grammars: [{ ...grammar, injections: ['source.*'] }] },
    { languages: Array.from({ length: 17 }, (_, i) => ({ id: `lang-${i}` })), grammars: [grammar] }
  ])(
    'rejects ambiguous ownership, invalid paths, and executable declarations: %j',
    (contributes) => {
      expect(parsePluginManifest({ ...manifest, contributes }).ok).toBe(false)
    }
  )

  it('accepts the actual migration grammar, without executing any expressions during validation', async () => {
    const artifact = await readFile(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'lib',
        'monaco-languages',
        'textmate-grammars',
        'typst.tmLanguage.json'
      ),
      'utf8'
    )
    const parsed = parsePluginGrammarArtifact(artifact, 'source.typst')
    expect(() => validatePluginGrammarIncludes([parsed])).not.toThrow()
    expect(
      parse({ scopeName: 'source.sample', patterns: [{ match: '(a+)+$', name: 'keyword' }] })
    ).toBeDefined()
  })

  it('resolves nested repositories and declared package-local includes, rejecting missing scopes', () => {
    const first = parse({
      scopeName: 'source.sample',
      patterns: [
        { include: 'source.second#word' },
        { patterns: [{ include: '#nested' }], repository: { nested: { match: 'x' } } }
      ]
    })
    const second = parsePluginGrammarArtifact(
      JSON.stringify({
        scopeName: 'source.second',
        patterns: [],
        repository: { word: { match: 'word' } }
      }),
      'source.second'
    )
    expect(() => validatePluginGrammarIncludes([first, second])).not.toThrow()
    expect(() => validatePluginGrammarIncludes([first])).toThrow('unresolved package-local')
    expect(() =>
      validatePluginGrammarIncludes([
        parse({ scopeName: 'source.sample', patterns: [{ include: '#absent' }] })
      ])
    ).toThrow('unresolved package-local')
  })

  it.each([
    { scopeName: 'source.sample', patterns: [], injections: {} },
    { scopeName: 'source.sample', patterns: [{ match: 'a', callback: 'code.js' }] },
    { scopeName: 'source.other', patterns: [] },
    { scopeName: 'source.sample', patterns: [], repository: { constructor: { match: 'a' } } }
  ])('rejects unknown fields, unsafe keys and declaration mismatch: %j', (value) => {
    expect(() => parse(value)).toThrow()
  })

  it('checks UTF-8 size and traversal depth before recursive grammar validation', () => {
    expect(() =>
      parse({
        scopeName: 'source.sample',
        patterns: [],
        comment: 'é'.repeat(PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES / 2)
      })
    ).toThrow('byte limit')
    let nested: unknown = { match: 'x' }
    for (let i = 0; i < 65; i++) {
      nested = { patterns: [nested] }
    }
    expect(() => parse({ scopeName: 'source.sample', patterns: [nested] })).toThrow(
      'traversal limit'
    )
  })

  it('allows literal editing configuration and rejects callback and extra regex configuration', () => {
    expect(
      parsePluginLanguageConfiguration(
        JSON.stringify({
          comments: { blockComment: ['/*', '*/'] },
          brackets: [['(', ')']],
          autoClosingPairs: [{ open: '(', close: ')' }]
        })
      )
    ).toBeDefined()
    for (const config of [
      { wordPattern: '.*' },
      { onEnterRules: [] },
      { main: 'code.js' },
      { comments: { lineComment: '//', callback: 'x' } }
    ]) {
      expect(() => parsePluginLanguageConfiguration(JSON.stringify(config))).toThrow()
    }
  })

  it('validates qualified metadata ownership and payload scope availability at the receiving boundary', () => {
    expect(pluginSyntaxPackMetadataSchema.safeParse(pack).success).toBe(true)
    expect(
      pluginSyntaxPackMetadataSchema.safeParse({
        ...pack,
        languages: [{ ...pack.languages[0], key: 'syntax:other.publisher/sample' }]
      }).success
    ).toBe(false)
    expect(
      pluginSyntaxPackMetadataSchema.safeParse({
        ...pack,
        languages: [pack.languages[0], pack.languages[0]]
      }).success
    ).toBe(false)
    const payload = {
      ...pack,
      languages: pack.languages.map((item) => ({ ...item, configuration: {} })),
      grammars: [{ scopeName: 'source.sample', content: '{}' }]
    }
    expect(pluginSyntaxPackPayloadSchema.safeParse(payload).success).toBe(true)
    expect(
      pluginSyntaxPackPayloadSchema.safeParse({
        ...payload,
        grammars: [{ scopeName: 'source.other', content: '{}' }]
      }).success
    ).toBe(false)
    expect(
      pluginSyntaxPackPayloadSchema.safeParse({
        ...payload,
        grammars: [...payload.grammars, ...payload.grammars]
      }).success
    ).toBe(false)
  })
})
