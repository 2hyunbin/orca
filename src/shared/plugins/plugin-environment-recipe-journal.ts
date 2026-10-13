import { z } from 'zod'
import { parseExecutionHostId } from '../execution-host'
import {
  ENVIRONMENT_RECIPE_ACTIONS,
  environmentRecipeContextIdSchema,
  environmentRecipeRequestSchema,
  environmentRecipeResourceSchema
} from '../environment-recipe-protocol'

export const ENVIRONMENT_RECIPE_JOURNAL_BYTES = 8 * 1024 * 1024
export const ENVIRONMENT_RECIPE_JOURNAL_OPERATION_LIMIT = 4096
export const ENVIRONMENT_RECIPE_JOURNAL_RESOURCE_LIMIT = 1024
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const environmentRecipeJournalBindingSchema = z.strictObject({
  executionHostId: z.string().refine((value) => parseExecutionHostId(value)?.id === value),
  providerId: environmentRecipeRequestSchema.options[0].shape.providerId,
  contextId: environmentRecipeContextIdSchema.optional(),
  sourceDigest: digest,
  recipeDigest: digest
})

const operationIdentity = z.strictObject({
  operationId: z.uuid(),
  requestDigest: digest,
  action: z.enum(ENVIRONMENT_RECIPE_ACTIONS),
  resourceId: z.string().min(1).max(256).optional(),
  expectedRevision: z.string().min(1).max(256).optional(),
  startedAt: z.number().int().nonnegative()
})

export const environmentRecipeJournalOperationSchema = z.discriminatedUnion('status', [
  operationIdentity.extend({ status: z.literal('pending') }),
  operationIdentity.extend({
    status: z.enum(['completed', 'refused', 'unverifiable']),
    resultDigest: digest,
    finishedAt: z.number().int().nonnegative(),
    reason: z.string().min(1).max(128).optional()
  })
])

export const environmentRecipeJournalSchema = z
  .strictObject({
    version: z.literal(1),
    binding: environmentRecipeJournalBindingSchema,
    resources: z
      .array(environmentRecipeResourceSchema)
      .max(ENVIRONMENT_RECIPE_JOURNAL_RESOURCE_LIMIT),
    operations: z
      .array(environmentRecipeJournalOperationSchema)
      .max(ENVIRONMENT_RECIPE_JOURNAL_OPERATION_LIMIT)
  })
  .superRefine((journal, context) => {
    for (const [field, ids] of [
      ['resources', journal.resources.map((resource) => resource.id)],
      ['operations', journal.operations.map((operation) => operation.operationId)]
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', path: [field], message: 'duplicate journal identity' })
      }
    }
    if (journal.operations.filter((operation) => operation.status === 'pending').length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['operations'],
        message: 'competing pending operations'
      })
    }
  })

export type EnvironmentRecipeJournalBinding = z.infer<typeof environmentRecipeJournalBindingSchema>
export type EnvironmentRecipeJournalOperation = z.infer<
  typeof environmentRecipeJournalOperationSchema
>
export type EnvironmentRecipeJournal = z.infer<typeof environmentRecipeJournalSchema>
