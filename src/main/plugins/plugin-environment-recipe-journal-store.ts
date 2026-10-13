import {
  environmentRecipeRecoveryRequestSchema,
  parseEnvironmentRecipeRecoveryResponse,
  type EnvironmentRecipeRecoveryRequest,
  type EnvironmentRecipeRecoveryReceipt
} from '../../shared/environment-recipe-recovery-protocol'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { createHash } from 'node:crypto'
import {
  ENVIRONMENT_RECIPE_INPUT_BYTES,
  environmentRecipeRequestSchema,
  parseEnvironmentRecipeResponse,
  type EnvironmentRecipeRequest
} from '../../shared/environment-recipe-protocol'
import {
  type EnvironmentRecipeJournal,
  type EnvironmentRecipeJournalBinding,
  isEnvironmentRecipeOperationUnresolved,
  isEnvironmentRecipeResourceInventoryUnconfirmed,
  environmentRecipeRecoveredResourceId,
  type EnvironmentRecipeJournalOperation
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { withFileTransactionLock } from '../file-transaction-lock'
import type { EnvironmentRecipeExecutionResult } from './plugin-environment-recipe-execution'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validatedRequest(request: EnvironmentRecipeRequest): EnvironmentRecipeRequest {
  const parsed = environmentRecipeRequestSchema.parse(request)
  stringifyJsonWithinByteLimit(parsed, ENVIRONMENT_RECIPE_INPUT_BYTES - 1)
  return parsed
}

function requestDigest(request: EnvironmentRecipeRequest): string {
  return hash(`${JSON.stringify(request)}\n`)
}

/** One execution host owns the journal; clients invoke that host rather than sharing local caches. */
export class PluginEnvironmentRecipeJournalStore {
  private readonly file: PluginEnvironmentRecipeJournalFile

  constructor(userDataPath: string, binding: EnvironmentRecipeJournalBinding) {
    this.file = new PluginEnvironmentRecipeJournalFile(userDataPath, binding)
  }

  async snapshot(): Promise<EnvironmentRecipeJournal> {
    return this.file.read()
  }

  async begin(input: EnvironmentRecipeRequest): Promise<{
    kind: 'started' | 'recorded'
    operation: EnvironmentRecipeJournalOperation
  }> {
    const request = validatedRequest(structuredClone(input))
    this.requireProvider(request)
    return withFileTransactionLock(this.file.filePath, async () => {
      const journal = await this.file.read()
      const existing = journal.operations.find((entry) => entry.operationId === request.operationId)
      if (existing) {
        this.requireRequest(existing, request)
        return { kind: 'recorded', operation: existing }
      }
      if (request.action === 'list') {
        journal.operations = journal.operations.map((entry) =>
          entry.status === 'pending' && entry.action === 'list'
            ? {
                ...entry,
                status: 'unverifiable',
                reason: 'inventory-superseded',
                resultDigest: hash('inventory-superseded'),
                finishedAt: Math.max(Date.now(), entry.startedAt)
              }
            : entry
        )
      }
      if (
        journal.operations.some(
          (entry) => entry.status === 'pending' && isEnvironmentRecipeOperationUnresolved(entry)
        )
      ) {
        throw new Error('An environment operation is already pending')
      }
      if (
        request.action !== 'list' &&
        journal.operations.some(
          (entry) => isEnvironmentRecipeOperationUnresolved(entry) && entry.action !== 'list'
        )
      ) {
        throw new Error(
          'An uncertain environment mutation must be reconciled before another mutation'
        )
      }
      if ('resourceId' in request) {
        if (
          journal.operations.some((entry) =>
            isEnvironmentRecipeResourceInventoryUnconfirmed(entry, request.resourceId)
          )
        ) {
          throw new Error('Refresh inventory to confirm the recovered machine before changing it')
        }
        const resource = journal.resources.find((entry) => entry.id === request.resourceId)
        if (
          !resource ||
          resource.revision !== request.expectedRevision ||
          resource.state === 'deleted'
        ) {
          throw new Error('The selected environment resource or revision is no longer current')
        }
      }
      const operation: EnvironmentRecipeJournalOperation = {
        operationId: request.operationId,
        requestDigest: requestDigest(request),
        action: request.action,
        ...('resourceId' in request
          ? { resourceId: request.resourceId, expectedRevision: request.expectedRevision }
          : {}),
        startedAt: Date.now(),
        status: 'pending'
      }
      journal.operations.push(operation)
      this.file.write(journal)
      return { kind: 'started', operation }
    })
  }

  async finish(
    input: EnvironmentRecipeRequest,
    result: EnvironmentRecipeExecutionResult
  ): Promise<EnvironmentRecipeJournalOperation> {
    const request = validatedRequest(structuredClone(input))
    this.requireProvider(request)
    const outcome = structuredClone(result)
    const response =
      outcome.kind === 'completed'
        ? parseEnvironmentRecipeResponse(JSON.stringify(outcome.response), request)
        : null
    const resultDigest = hash(JSON.stringify(outcome))
    return withFileTransactionLock(this.file.filePath, async () => {
      const journal = await this.file.read()
      const index = journal.operations.findIndex(
        (entry) => entry.operationId === request.operationId
      )
      const existing = journal.operations[index]
      if (!existing) {
        throw new Error('Environment completion has no durable pending intent')
      }
      this.requireRequest(existing, request)
      if (existing.status !== 'pending') {
        if (existing.resultDigest !== resultDigest) {
          throw new Error('Environment completion contradicts an already recorded outcome')
        }
        return existing
      }
      if (existing.recovery && outcome.kind === 'completed') {
        const recovered = existing.recovery.receipt.outcome
        const matches =
          recovered.kind === 'completed'
            ? response?.kind === 'resource' &&
              JSON.stringify(response.resource) === JSON.stringify(recovered.resource)
            : response?.kind === 'error' && response.code === recovered.code
        if (!matches) {
          throw new Error('Late completion contradicts the provider receipt')
        }
      }
      if (!existing.recovery && response && response.kind !== 'error') {
        const resources = response.kind === 'inventory' ? response.resources : [response.resource]
        const merged = new Map(journal.resources.map((resource) => [resource.id, resource]))
        for (const resource of resources) {
          merged.set(resource.id, resource)
        }
        // Missing rows in a page never prove deletion, even on the last page.
        journal.resources = [...merged.values()]
        const confirmed = new Set(resources.map((entry) => entry.id))
        for (const recorded of journal.operations) {
          const id = environmentRecipeRecoveredResourceId(recorded)
          if (id && recorded.recovery && confirmed.has(id)) {
            recorded.recovery.inventoryConfirmed = true
          }
        }
      }
      const operation: EnvironmentRecipeJournalOperation = {
        ...existing,
        status: outcome.kind,
        resultDigest,
        finishedAt: Math.max(Date.now(), existing.startedAt),
        ...('reason' in outcome ? { reason: outcome.reason } : {})
      }
      journal.operations[index] = operation
      this.file.write(journal)
      return operation
    })
  }

  async recoveryRequest(
    originalOperationId: string,
    queryId: string
  ): Promise<{
    operation: EnvironmentRecipeJournalOperation
    request: EnvironmentRecipeRecoveryRequest | null
  }> {
    const journal = await this.file.read()
    const operation = journal.operations.find((entry) => entry.operationId === originalOperationId)
    if (!operation || operation.action === 'list') {
      throw new Error('There is no recoverable machine operation')
    }
    if (!isEnvironmentRecipeOperationUnresolved(operation)) {
      return { operation, request: null }
    }
    const request = this.makeRecoveryRequest(operation, queryId)
    return { operation, request }
  }

  async recordRecoveryReceipt(
    inputRequest: EnvironmentRecipeRecoveryRequest,
    input: EnvironmentRecipeRecoveryReceipt,
    authority: { isCurrent(): boolean }
  ): Promise<EnvironmentRecipeJournalOperation> {
    const request = environmentRecipeRecoveryRequestSchema.parse(structuredClone(inputRequest))
    const receipt = parseEnvironmentRecipeRecoveryResponse(JSON.stringify(input), request)
    if (receipt.kind !== 'receipt') {
      throw new Error('Recovery did not provide a terminal receipt')
    }
    return withFileTransactionLock(this.file.filePath, async () => {
      const journal = await this.file.read()
      const operation = journal.operations.find(
        (entry) => entry.operationId === request.operation.operationId
      )
      if (
        !operation ||
        JSON.stringify(this.makeRecoveryRequest(operation, request.queryId)) !==
          JSON.stringify(request)
      ) {
        throw new Error('Recovery receipt no longer belongs to this journal operation')
      }
      if (!authority.isCurrent()) {
        throw new Error('Recovery authority changed before recording its receipt')
      }
      if (operation.recovery) {
        if (
          JSON.stringify(operation.recovery.receipt.outcome) !== JSON.stringify(receipt.outcome)
        ) {
          throw new Error('Recovery contradicts an already recorded provider receipt')
        }
        return operation
      }
      if (!isEnvironmentRecipeOperationUnresolved(operation)) {
        return operation
      }
      const resourceId =
        receipt.outcome.kind === 'completed' ? receipt.outcome.resource.id : operation.resourceId
      operation.recovery = {
        queriedAt: Date.now(),
        receipt,
        inventoryConfirmed: !resourceId || Boolean(receipt.currentResource)
      }
      if (receipt.currentResource) {
        const merged = new Map(journal.resources.map((entry) => [entry.id, entry]))
        merged.set(receipt.currentResource.id, receipt.currentResource)
        journal.resources = [...merged.values()]
      }
      this.file.write(journal)
      return operation
    })
  }

  private makeRecoveryRequest(
    operation: EnvironmentRecipeJournalOperation,
    queryId: string
  ): EnvironmentRecipeRecoveryRequest {
    return environmentRecipeRecoveryRequestSchema.parse({
      protocolVersion: 1,
      queryId,
      providerId: this.file.binding.providerId,
      contextId: this.file.binding.contextId,
      operation: {
        operationId: operation.operationId,
        requestDigest: operation.requestDigest,
        action: operation.action,
        ...(operation.action === 'create'
          ? {}
          : { resourceId: operation.resourceId, expectedRevision: operation.expectedRevision })
      }
    })
  }

  private requireProvider(request: EnvironmentRecipeRequest): void {
    if (
      request.providerId !== this.file.binding.providerId ||
      request.contextId !== this.file.binding.contextId
    ) {
      throw new Error('Environment request names another journal owner or provider context')
    }
  }

  private requireRequest(
    operation: EnvironmentRecipeJournalOperation,
    request: EnvironmentRecipeRequest
  ): void {
    if (operation.requestDigest !== requestDigest(request)) {
      throw new Error('Environment operation identity was reused for another request')
    }
  }
}
