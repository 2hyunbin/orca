import { environmentRecipeRecoveryReceiptSchema } from '../environment-recipe-recovery-protocol'
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
  recipeDigest: digest,
  journalId: z.uuid().optional()
})

const operationIdentity = z.strictObject({
  operationId: z.uuid(),
  requestDigest: digest,
  action: z.enum(ENVIRONMENT_RECIPE_ACTIONS),
  resourceId: z.string().min(1).max(256).optional(),
  expectedRevision: z.string().min(1).max(256).optional(),
  startedAt: z.number().int().nonnegative(),
  originBinding: environmentRecipeJournalBindingSchema.optional(),
  recovery: z
    .strictObject({
      queriedAt: z.number().int().nonnegative(),
      receipt: environmentRecipeRecoveryReceiptSchema,
      inventoryConfirmed: z.boolean()
    })
    .optional()
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
    previousBindings: z
      .array(
        z.strictObject({
          binding: environmentRecipeJournalBindingSchema,
          archivedAt: z.number().int().nonnegative()
        })
      )
      .max(128)
      .optional(),
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
    for (const previous of journal.previousBindings ?? []) {
      if (
        previous.binding.providerId !== journal.binding.providerId ||
        previous.binding.executionHostId !== journal.binding.executionHostId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['previousBindings'],
          message: 'history belongs to another provider or host'
        })
      }
    }
    for (const operation of journal.operations) {
      if (
        operation.originBinding &&
        (operation.originBinding.providerId !== journal.binding.providerId ||
          operation.originBinding.contextId !== journal.binding.contextId ||
          operation.originBinding.executionHostId !== journal.binding.executionHostId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: 'operation belongs to another account or host'
        })
      }
      const receipt = operation.recovery?.receipt
      if (
        receipt &&
        (receipt.providerId !== journal.binding.providerId ||
          receipt.contextId !== journal.binding.contextId ||
          receipt.operation.operationId !== operation.operationId ||
          receipt.operation.requestDigest !== operation.requestDigest ||
          receipt.operation.action !== operation.action ||
          ('resourceId' in receipt.operation &&
            (receipt.operation.resourceId !== operation.resourceId ||
              receipt.operation.expectedRevision !== operation.expectedRevision)))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: 'recovery receipt names another owner or operation'
        })
      }
    }
    if (
      journal.operations.filter(
        (operation) => operation.status === 'pending' && !operation.recovery
      ).length > 1
    ) {
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

export function isEnvironmentRecipeOperationUnresolved(
  operation: EnvironmentRecipeJournalOperation
): boolean {
  return (
    !operation.recovery &&
    (operation.status === 'pending' ||
      (operation.status === 'unverifiable' && operation.action !== 'list'))
  )
}
export function environmentRecipeRecoveredResourceId(
  operation: EnvironmentRecipeJournalOperation
): string | null {
  const receipt = operation.recovery?.receipt
  if (!receipt) {
    return null
  }
  return receipt.outcome.kind === 'completed'
    ? receipt.outcome.resource.id
    : (operation.resourceId ?? null)
}
export function isEnvironmentRecipeResourceInventoryUnconfirmed(
  operation: EnvironmentRecipeJournalOperation,
  resourceId?: string
): boolean {
  const id = environmentRecipeRecoveredResourceId(operation)
  return Boolean(
    id &&
    operation.recovery &&
    !operation.recovery.inventoryConfirmed &&
    (resourceId === undefined || resourceId === id)
  )
}
