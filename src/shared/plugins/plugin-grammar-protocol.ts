import { z } from 'zod'

export const PLUGIN_GRAMMAR_WORK_SLICE_MS = 100
export const PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS = 2_000
export const PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS = 30_000
export const PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT = 500_000
export const PLUGIN_GRAMMAR_MODEL_LINE_LIMIT = 20_000
export const PLUGIN_GRAMMAR_TOKEN_LIMIT = 100_000
export const PLUGIN_GRAMMAR_QUEUE_LIMIT = 8
export const PLUGIN_GRAMMAR_CACHE_CHARACTER_LIMIT = 2_000_000
export const PLUGIN_GRAMMAR_CACHE_LINE_LIMIT = 80_000

export const PLUGIN_GRAMMAR_TOKEN_TYPES = [
  'comment',
  'string',
  'keyword',
  'number',
  'type',
  'function',
  'variable',
  'operator'
] as const

export type PluginGrammarSource = { scopeName: string; content: string }

export type PluginGrammarRequest = {
  id: number
  generation: number
  version: number
  scopeName: string
  grammars: readonly PluginGrammarSource[]
  text: string
}

const identity = {
  id: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  version: z.number().int().nonnegative()
}

export const pluginGrammarResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('progress'), ...identity }),
  z.strictObject({
    type: z.literal('complete'),
    ...identity,
    data: z.instanceof(Uint32Array).refine((data) => data.length <= PLUGIN_GRAMMAR_TOKEN_LIMIT * 5)
  }),
  z.strictObject({ type: z.literal('unavailable'), ...identity })
])

export type PluginGrammarResponse = z.infer<typeof pluginGrammarResponseSchema>

export function isValidPluginGrammarTokenData(data: Uint32Array, text: string): boolean {
  if (
    data.length % 5 !== 0 ||
    data.length > PLUGIN_GRAMMAR_TOKEN_LIMIT * 5 ||
    text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT
  ) {
    return false
  }
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT) {
    return false
  }
  let line = 0
  let start = 0
  let previousEnd = 0
  for (let offset = 0; offset < data.length; offset += 5) {
    const deltaLine = data[offset]
    line += deltaLine
    start = deltaLine === 0 ? start + data[offset + 1] : data[offset + 1]
    if (deltaLine !== 0) {
      previousEnd = 0
    }
    const length = data[offset + 2]
    if (
      line >= lines.length ||
      length === 0 ||
      start < previousEnd ||
      start + length > lines[line].length ||
      data[offset + 3] >= PLUGIN_GRAMMAR_TOKEN_TYPES.length ||
      data[offset + 4] !== 0
    ) {
      return false
    }
    previousEnd = start + length
  }
  return true
}
