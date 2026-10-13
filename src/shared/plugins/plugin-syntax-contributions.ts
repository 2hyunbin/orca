import { z } from 'zod'
import { pluginIdSchema, pluginRelativePathSchema } from './plugin-manifest-fields'

export const PLUGIN_SYNTAX_LANGUAGE_LIMIT = 16
export const PLUGIN_SYNTAX_GRAMMAR_LIMIT = 16
export const PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_SYNTAX_TOTAL_MAX_BYTES = 8 * 1024 * 1024
export const PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES = 64 * 1024
export const PLUGIN_SYNTAX_JSON_DEPTH_LIMIT = 64

export const pluginGrammarScopeSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/)

export const pluginSyntaxLanguageSchema = z.strictObject({
  id: pluginIdSchema,
  aliases: z.array(z.string().min(1).max(128)).max(16).default([]),
  extensions: z
    .array(
      z
        .string()
        .max(64)
        .regex(/^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
    )
    .max(32)
    .default([]),
  filenames: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .refine(
          (name) =>
            name !== '.' &&
            name !== '..' &&
            !/[<>:"/\\|?*]/.test(name) &&
            !Array.from(name).some((character) => character.charCodeAt(0) < 32),
          'must be a portable basename'
        )
    )
    .max(32)
    .default([]),
  configuration: pluginRelativePathSchema.optional()
})

export const pluginSyntaxGrammarSchema = z.strictObject({
  language: pluginIdSchema,
  scopeName: pluginGrammarScopeSchema,
  path: pluginRelativePathSchema
})

export type PluginSyntaxLanguage = z.infer<typeof pluginSyntaxLanguageSchema>
export type PluginSyntaxGrammar = z.infer<typeof pluginSyntaxGrammarSchema>

export function validatePluginSyntaxContributions(
  input: { languages: PluginSyntaxLanguage[]; grammars: PluginSyntaxGrammar[] },
  ctx: z.RefinementCtx
): void {
  const languages = new Set<string>()
  const scopes = new Set<string>()
  const grammars = new Set<string>()
  for (const [index, language] of input.languages.entries()) {
    if (languages.has(language.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'languages', index],
        message: 'duplicate syntax language id'
      })
    }
    languages.add(language.id)
    for (const field of ['extensions', 'filenames'] as const) {
      const values = language[field].map((value) => value.toLowerCase())
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'languages', index, field],
          message: 'duplicate filename association'
        })
      }
    }
  }
  for (const [index, grammar] of input.grammars.entries()) {
    if (!languages.has(grammar.language)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'grammars', index, 'language'],
        message: 'grammar must belong to a declared package language'
      })
    }
    if (scopes.has(grammar.scopeName) || grammars.has(grammar.language)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'grammars', index],
        message: 'duplicate grammar scope or language'
      })
    }
    scopes.add(grammar.scopeName)
    grammars.add(grammar.language)
  }
  for (const [index, language] of input.languages.entries()) {
    if (!grammars.has(language.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'languages', index],
        message: 'syntax language requires a package grammar'
      })
    }
  }
}
