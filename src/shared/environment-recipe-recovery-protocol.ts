import { z } from 'zod'
import {
  environmentRecipeContextIdSchema,
  environmentRecipeRequestSchema,
  environmentRecipeResourceSchema,
  expectedEnvironmentRecipeResourceState,
  parseEnvironmentRecipeJsonContent
} from './environment-recipe-protocol'

const original = z.strictObject({
  operationId: z.uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/)
})
export const environmentRecipeRecoveryOperationSchema = z.discriminatedUnion('action', [
  original.extend({ action: z.literal('create') }),
  original.extend({
    action: z.enum(['delete', 'sleep', 'resume', 'archive']),
    resourceId: environmentRecipeResourceSchema.shape.id,
    expectedRevision: environmentRecipeResourceSchema.shape.revision
  })
])
const identity = z.strictObject({
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  providerId: environmentRecipeRequestSchema.options[0].shape.providerId,
  contextId: environmentRecipeContextIdSchema,
  operation: environmentRecipeRecoveryOperationSchema
})
export const environmentRecipeRecoveryRequestSchema = identity
const outcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('completed'), resource: environmentRecipeResourceSchema }),
  z.strictObject({
    kind: z.literal('refused'),
    code: z.enum(['conflict', 'not-found', 'authentication-required', 'unsupported'])
  })
])
export const environmentRecipeRecoveryReceiptSchema = identity
  .extend({
    kind: z.literal('receipt'),
    outcome,
    currentResource: environmentRecipeResourceSchema.optional()
  })
  .superRefine((receipt, context) => {
    const { operation, outcome, currentResource } = receipt
    if (outcome.kind === 'completed') {
      if (
        outcome.resource.state !== expectedEnvironmentRecipeResourceState(operation.action) ||
        ('resourceId' in operation && outcome.resource.id !== operation.resourceId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'receipt does not confirm the original transition'
        })
      }
    }
    const id =
      outcome.kind === 'completed'
        ? outcome.resource.id
        : 'resourceId' in operation
          ? operation.resourceId
          : null
    if (currentResource && currentResource.id !== id) {
      context.addIssue({
        code: 'custom',
        path: ['currentResource'],
        message: 'current inventory names another resource'
      })
    }
  })
export const environmentRecipeRecoveryResponseSchema = z.union([
  environmentRecipeRecoveryReceiptSchema,
  identity.extend({ kind: z.enum(['pending', 'unknown']) }),
  identity.extend({
    kind: z.literal('error'),
    code: z.enum(['authentication-required', 'unsupported', 'unavailable'])
  })
])
export type EnvironmentRecipeRecoveryRequest = z.infer<
  typeof environmentRecipeRecoveryRequestSchema
>
export type EnvironmentRecipeRecoveryReceipt = z.infer<
  typeof environmentRecipeRecoveryReceiptSchema
>
export type EnvironmentRecipeRecoveryResponse = z.infer<
  typeof environmentRecipeRecoveryResponseSchema
>

export function parseEnvironmentRecipeRecoveryResponse(
  stdout: string,
  request: EnvironmentRecipeRecoveryRequest
): EnvironmentRecipeRecoveryResponse {
  const result = environmentRecipeRecoveryResponseSchema.parse(
    parseEnvironmentRecipeJsonContent(stdout)
  )
  if (
    result.protocolVersion !== request.protocolVersion ||
    result.queryId !== request.queryId ||
    result.providerId !== request.providerId ||
    result.contextId !== request.contextId ||
    JSON.stringify(result.operation) !== JSON.stringify(request.operation)
  ) {
    throw new Error('Provider receipt does not belong to this operation or account')
  }
  return result
}
