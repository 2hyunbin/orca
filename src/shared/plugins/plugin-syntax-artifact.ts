import { z } from 'zod'
import { isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES,
  PLUGIN_SYNTAX_JSON_DEPTH_LIMIT,
  pluginGrammarScopeSchema
} from './plugin-syntax-contributions'

type GrammarRule = {
  name?: string
  contentName?: string
  comment?: string
  include?: string
  match?: string
  begin?: string
  end?: string
  while?: string
  applyEndPatternLast?: boolean | number
  patterns?: GrammarRule[]
  repository?: Record<string, GrammarRule>
  captures?: Record<string, GrammarRule>
  beginCaptures?: Record<string, GrammarRule>
  endCaptures?: Record<string, GrammarRule>
  whileCaptures?: Record<string, GrammarRule>
}

const repositoryKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const captureKey = z.string().regex(/^(?:0|[1-9][0-9]{0,2})$/)
const text = z.string().max(64 * 1024)
const ruleSchema: z.ZodType<GrammarRule> = z.lazy(() =>
  z.strictObject({
    name: z.string().max(1024).optional(),
    contentName: z.string().max(1024).optional(),
    comment: text.optional(),
    include: z
      .string()
      .min(1)
      .max(256)
      .regex(
        /^(?:\$self|\$base|#[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+(?:#[A-Za-z0-9_-]+)?)$/
      )
      .optional(),
    match: text.optional(),
    begin: text.optional(),
    end: text.optional(),
    while: text.optional(),
    applyEndPatternLast: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    patterns: z.array(ruleSchema).max(10_000).optional(),
    repository: z.record(repositoryKey, ruleSchema).optional(),
    captures: z.record(captureKey, ruleSchema).optional(),
    beginCaptures: z.record(captureKey, ruleSchema).optional(),
    endCaptures: z.record(captureKey, ruleSchema).optional(),
    whileCaptures: z.record(captureKey, ruleSchema).optional()
  })
)

const grammarSchema = z.strictObject({
  scopeName: pluginGrammarScopeSchema,
  name: z.string().max(256).optional(),
  comment: text.optional(),
  fileTypes: z.array(z.string().max(128)).max(64).optional(),
  uuid: z.string().max(128).optional(),
  keyEquivalent: z.string().max(128).optional(),
  patterns: z.array(ruleSchema).max(10_000),
  repository: z.record(repositoryKey, ruleSchema).default({})
})

const literal = z.string().min(1).max(128)
const pair = z.tuple([literal, literal])
const closingPair = z.strictObject({ open: literal, close: literal })
export const pluginLanguageConfigurationSchema = z.strictObject({
  comments: z
    .strictObject({ lineComment: literal.optional(), blockComment: pair.optional() })
    .optional(),
  brackets: z.array(pair).max(64).optional(),
  autoClosingPairs: z.array(closingPair).max(64).optional(),
  surroundingPairs: z.array(closingPair).max(64).optional()
})
export type PluginLanguageConfiguration = z.infer<typeof pluginLanguageConfigurationSchema>
export type PluginGrammarArtifact = z.infer<typeof grammarSchema>

function boundedJson(raw: string, limit: number): unknown {
  if (!isUtf8ByteLengthWithinLimit(raw, limit)) {
    throw new Error('syntax artifact exceeds byte limit')
  }
  const parsed: unknown = JSON.parse(raw)
  const pending = [{ value: parsed, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) {
      break
    }
    if (++nodes > 100_000 || entry.depth > PLUGIN_SYNTAX_JSON_DEPTH_LIMIT) {
      throw new Error('syntax artifact exceeds traversal limit')
    }
    if (entry.value && typeof entry.value === 'object') {
      for (const [key, value] of Object.entries(entry.value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          throw new Error('unsafe syntax artifact key')
        }
        pending.push({ value, depth: entry.depth + 1 })
      }
    }
  }
  return parsed
}

export function parsePluginLanguageConfiguration(raw: string): PluginLanguageConfiguration {
  return pluginLanguageConfigurationSchema.parse(
    boundedJson(raw, PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES)
  )
}

export function parsePluginGrammarArtifact(raw: string, scopeName: string): PluginGrammarArtifact {
  const grammar = grammarSchema.parse(boundedJson(raw, PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES))
  if (grammar.scopeName !== scopeName) {
    throw new Error('grammar scope does not match its declaration')
  }
  return grammar
}

export function validatePluginGrammarIncludes(grammars: readonly PluginGrammarArtifact[]): void {
  const byScope = new Map(grammars.map((grammar) => [grammar.scopeName, grammar]))
  for (const grammar of grammars) {
    const pending: { rule: GrammarRule; keys: Set<string> }[] = [
      {
        rule: { patterns: grammar.patterns, repository: grammar.repository },
        keys: new Set(Object.keys(grammar.repository))
      }
    ]
    while (pending.length) {
      const entry = pending.pop()
      if (!entry) {
        break
      }
      const { rule } = entry
      const keys = new Set([...entry.keys, ...Object.keys(rule.repository ?? {})])
      if (rule.include && rule.include !== '$self' && rule.include !== '$base') {
        const [scope, repository] = rule.include.split('#')
        const target = scope ? byScope.get(scope) : grammar
        if (
          !target ||
          (repository &&
            !(scope ? Object.hasOwn(target.repository, repository) : keys.has(repository)))
        ) {
          throw new Error(`unresolved package-local grammar include: ${rule.include}`)
        }
      }
      for (const child of [
        ...(rule.patterns ?? []),
        ...Object.values(rule.repository ?? {}),
        ...Object.values(rule.captures ?? {}),
        ...Object.values(rule.beginCaptures ?? {}),
        ...Object.values(rule.endCaptures ?? {}),
        ...Object.values(rule.whileCaptures ?? {})
      ]) {
        pending.push({ rule: child, keys })
      }
    }
  }
}
