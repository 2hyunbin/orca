import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-tab-key'
import { isUtf8ByteLengthWithinLimit, getUtf8ByteLength } from '../utf8-byte-limits'
import {
  PLUGIN_SYNTAX_GRAMMAR_LIMIT,
  PLUGIN_SYNTAX_LANGUAGE_LIMIT,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES,
  PLUGIN_SYNTAX_TOTAL_MAX_BYTES,
  pluginSyntaxLanguageSchema,
  pluginGrammarScopeSchema
} from './plugin-syntax-contributions'
import { pluginLanguageConfigurationSchema } from './plugin-syntax-artifact'

const languageMetadataSchema = pluginSyntaxLanguageSchema
  .omit({ configuration: true })
  .extend({
    key: z.string().max(256).startsWith('syntax:'),
    scopeName: pluginGrammarScopeSchema,
    builtInLanguage: z.literal('typst').optional()
  })
  .strict()

const metadataShape = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey),
  name: z.string().min(1).max(256),
  revision: z.string().min(1).max(128),
  languages: z.array(languageMetadataSchema).min(1).max(PLUGIN_SYNTAX_LANGUAGE_LIMIT)
})

function validateIdentities(pack: z.infer<typeof metadataShape>, ctx: z.RefinementCtx): void {
  const keys = new Set<string>()
  const scopes = new Set<string>()
  for (const [index, language] of pack.languages.entries()) {
    if (
      language.key !== pluginSyntaxLanguageKey(pack.pluginKey, language.id) ||
      keys.has(language.key) ||
      scopes.has(language.scopeName) ||
      (language.builtInLanguage !== undefined &&
        (pack.pluginKey !== 'stablyai.orca-syntax-typst' || language.id !== 'typst'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['languages', index],
        message: 'syntax identity must be unique and match its package owner'
      })
    }
    keys.add(language.key)
    scopes.add(language.scopeName)
  }
}

export const pluginSyntaxPackMetadataSchema = metadataShape.superRefine(validateIdentities)

export const pluginSyntaxPackPayloadSchema = metadataShape
  .extend({
    languages: z
      .array(
        languageMetadataSchema.extend({ configuration: pluginLanguageConfigurationSchema }).strict()
      )
      .min(1)
      .max(PLUGIN_SYNTAX_LANGUAGE_LIMIT),
    grammars: z
      .array(
        z.strictObject({
          scopeName: pluginGrammarScopeSchema,
          content: z
            .string()
            .refine((text) => isUtf8ByteLengthWithinLimit(text, PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES))
        })
      )
      .min(1)
      .max(PLUGIN_SYNTAX_GRAMMAR_LIMIT)
  })
  .strict()
  .superRefine((pack, ctx) => {
    validateIdentities(pack, ctx)
    if (
      pack.grammars.reduce((sum, grammar) => sum + getUtf8ByteLength(grammar.content), 0) >
      PLUGIN_SYNTAX_TOTAL_MAX_BYTES
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['grammars'],
        message: 'syntax pack exceeds total bytes'
      })
    }
    const scopes = new Set(pack.grammars.map((grammar) => grammar.scopeName))
    if (
      scopes.size !== pack.grammars.length ||
      pack.languages.some((item) => !scopes.has(item.scopeName))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['languages'],
        message: 'syntax payload must contain each declared grammar exactly once'
      })
    }
  })

export function pluginSyntaxLanguageKey(pluginKey: string, id: string): string {
  return `syntax:${pluginKey}/${id}`
}

export type PluginSyntaxPackMetadata = z.infer<typeof pluginSyntaxPackMetadataSchema>
export type PluginSyntaxPackPayload = z.infer<typeof pluginSyntaxPackPayloadSchema>
export type PluginSyntaxLanguageContent = Omit<PluginSyntaxPackPayload['languages'][number], 'key'>
