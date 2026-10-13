import { z } from 'zod'
import { assertJsonTextStructureWithinLimits } from '../json-text-structure-limit'
import {
  ENVIRONMENT_RECIPE_ACTIONS,
  type EnvironmentRecipeAction
} from '../environment-recipe-protocol'
import { isPluginManifestId } from './plugin-id-format'
import { isQualifiedPluginKey } from './plugin-tab-key'

export const PLUGIN_ENVIRONMENT_RECIPE_BYTES = 64 * 1024
const literal = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed')
export const environmentRecipeCommandSchema = z.strictObject({
  program: literal(4096),
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((value) => !value.includes('\0'))
    )
    .max(64),
  timeoutSeconds: z.number().int().min(1).max(600).default(120)
})
const field = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: literal(128),
  description: literal(1024).optional(),
  required: z.boolean().default(false),
  choices: z.array(literal(256)).min(1).max(64).optional()
})
export const pluginEnvironmentRecipeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(2).optional(),
    id: literal(128).refine(isPluginManifestId),
    name: literal(128),
    description: literal(1024),
    lifetime: z.enum(['long-lived', 'ephemeral', 'both']),
    createFields: z.array(field).max(32).default([]),
    recovery: z
      .strictObject({ protocolVersion: z.literal(1), command: environmentRecipeCommandSchema })
      .optional(),
    commands: z.strictObject({
      list: environmentRecipeCommandSchema,
      create: environmentRecipeCommandSchema.optional(),
      delete: environmentRecipeCommandSchema.optional(),
      sleep: environmentRecipeCommandSchema.optional(),
      resume: environmentRecipeCommandSchema.optional(),
      archive: environmentRecipeCommandSchema.optional()
    })
  })
  .superRefine((recipe, context) => {
    if (recipe.recovery && recipe.protocolVersion !== 2) {
      context.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'recovery requires context-aware protocol 2'
      })
    }
    if (new Set(recipe.createFields.map((value) => value.id)).size !== recipe.createFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['createFields'],
        message: 'duplicate create field'
      })
    }
    if (recipe.createFields.length && !recipe.commands.create) {
      context.addIssue({
        code: 'custom',
        path: ['createFields'],
        message: 'create fields require a create command'
      })
    }
    if (recipe.commands.sleep && !recipe.commands.resume) {
      context.addIssue({
        code: 'custom',
        path: ['commands', 'resume'],
        message: 'sleep requires a wake command'
      })
    }
  })

export type PluginEnvironmentRecipe = z.infer<typeof pluginEnvironmentRecipeSchema>
export type EnvironmentRecipeCommand = z.infer<typeof environmentRecipeCommandSchema>

export function parsePluginEnvironmentRecipe(raw: string): PluginEnvironmentRecipe {
  if (new TextEncoder().encode(raw).byteLength > PLUGIN_ENVIRONMENT_RECIPE_BYTES) {
    throw new Error('Environment recipe exceeds its byte limit')
  }
  assertJsonTextStructureWithinLimits(raw, { nestingDepth: 16, structuralTokens: 8192 })
  return pluginEnvironmentRecipeSchema.parse(JSON.parse(raw))
}

export function environmentRecipeProviderId(
  pluginKey: string,
  recipe: PluginEnvironmentRecipe
): string {
  if (!isQualifiedPluginKey(pluginKey)) {
    throw new Error('Environment recipe requires a qualified plugin owner')
  }
  return `${pluginKey}/${recipe.id}`
}

export function environmentRecipeDeclaredActions(
  recipe: PluginEnvironmentRecipe
): EnvironmentRecipeAction[] {
  return ENVIRONMENT_RECIPE_ACTIONS.filter((action) => recipe.commands[action] !== undefined)
}

export function validateEnvironmentRecipeCreateParameters(
  recipe: PluginEnvironmentRecipe,
  parameters: Readonly<Record<string, string>>
): void {
  if (!recipe.commands.create) {
    throw new Error('Environment provider does not support create')
  }
  const declared = new Map(recipe.createFields.map((value) => [value.id, value]))
  for (const [id, value] of Object.entries(parameters)) {
    const definition = declared.get(id)
    if (!definition || (definition.choices && !definition.choices.includes(value))) {
      throw new Error('Environment create parameter was not declared or is outside its choices')
    }
  }
  for (const definition of recipe.createFields) {
    if (definition.required && !parameters[definition.id]?.trim()) {
      throw new Error('A required environment create parameter is missing')
    }
  }
}

export function validateEnvironmentRecipeProtocol(
  recipe: PluginEnvironmentRecipe,
  request: { protocolVersion: 1 | 2 }
): void {
  if ((recipe.protocolVersion ?? 1) !== request.protocolVersion) {
    throw new Error('Environment recipe protocol does not match its declared version')
  }
}
