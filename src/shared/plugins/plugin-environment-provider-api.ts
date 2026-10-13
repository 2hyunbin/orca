import { z } from 'zod'
import {
  environmentRecipeContextIdSchema,
  environmentRecipeRequestSchema,
  type EnvironmentRecipeAction
} from '../environment-recipe-protocol'
import type { PluginEnvironmentRecipe } from './plugin-environment-recipe-artifact'
import { pluginConsentRequestSchema } from './plugin-consent-request'
import type { PluginEnvironmentRecipePreview } from './plugin-environment-recipe-preview'

export const pluginEnvironmentProviderReviewSchema = z.strictObject({
  providerId: environmentRecipeRequestSchema.options[0].shape.providerId,
  contextId: environmentRecipeContextIdSchema,
  consentFingerprint: pluginConsentRequestSchema.shape.reviewedFingerprint,
  reviewRevision: pluginConsentRequestSchema.shape.reviewedRevision.unwrap(),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/)
})
export type PluginEnvironmentProviderReview = z.infer<typeof pluginEnvironmentProviderReviewSchema>
export type PluginEnvironmentProviderReleaseReview = Omit<
  PluginEnvironmentProviderReview,
  'contextId'
>

export const pluginEnvironmentProviderExecuteSchema = z.strictObject({
  review: pluginEnvironmentProviderReviewSchema,
  request: environmentRecipeRequestSchema
})
export const pluginEnvironmentProviderCancelSchema = z.strictObject({ operationId: z.uuid() })

export type PluginEnvironmentProviderConfiguration =
  | { status: 'unconfigured' }
  | { status: 'ready'; contextId: string }
  | { status: 'migration-required'; contextId: string }
  | { status: 'unavailable' }

export type PluginEnvironmentProviderEntry = {
  executionHostId: 'local'
  providerId: string
  pluginKey: string
  name: string
  description: string
  lifetime: PluginEnvironmentRecipe['lifetime']
  protocolVersion: 1 | 2
  recoverySupported?: boolean
  actions: EnvironmentRecipeAction[]
  createFields: PluginEnvironmentRecipe['createFields']
  commands: PluginEnvironmentRecipePreview['commands']
  review: PluginEnvironmentProviderReleaseReview
  configuration: PluginEnvironmentProviderConfiguration
}
