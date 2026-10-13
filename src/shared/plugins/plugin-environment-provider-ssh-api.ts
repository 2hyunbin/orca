import { z } from 'zod'
import {
  environmentRecipeResourceSchema,
  type EnvironmentRecipeResource
} from '../environment-recipe-protocol'
import { pluginEnvironmentProviderReviewSchema } from './plugin-environment-provider-api'

export const pluginEnvironmentProviderSshPrepareSchema = z.strictObject({
  operationId: z.uuid(),
  review: pluginEnvironmentProviderReviewSchema,
  resourceId: environmentRecipeResourceSchema.shape.id,
  expectedRevision: environmentRecipeResourceSchema.shape.revision
})
export const pluginEnvironmentProviderSshSaveSchema = z.strictObject({
  ticketId: z.uuid(),
  approveEndpointUpdate: z.literal(true).optional(),
  identityFile: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes('\0'))
    .optional()
})
export const pluginEnvironmentProviderSshDiscardSchema = z.strictObject({ ticketId: z.uuid() })
export type EnvironmentProviderSshPreview = {
  ticketId: string
  expiresAt: number
  providerId: string
  contextId: string
  resource: EnvironmentRecipeResource
  endpointUpdate?: {
    previousConnection: NonNullable<EnvironmentRecipeResource['connection']>
    savedIdentityFile: boolean
  }
}
