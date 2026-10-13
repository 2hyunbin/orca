import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ENVIRONMENT_RECIPE_INPUT_BYTES,
  environmentRecipeRequestSchema,
  parseEnvironmentRecipeResponse,
  type EnvironmentRecipeRequest
} from '../../shared/environment-recipe-protocol'
import {
  ENVIRONMENT_RECIPE_JOURNAL_BYTES,
  environmentRecipeJournalBindingSchema,
  environmentRecipeJournalSchema,
  type EnvironmentRecipeJournal,
  type EnvironmentRecipeJournalBinding,
  type EnvironmentRecipeJournalOperation
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { writeSecureFile } from '../../shared/secure-file'
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
  private readonly filePath: string
  private readonly binding: EnvironmentRecipeJournalBinding

  constructor(userDataPath: string, binding: EnvironmentRecipeJournalBinding) {
    this.binding = environmentRecipeJournalBindingSchema.parse(structuredClone(binding))
    // Source changes must encounter old pending intents, rather than get an empty parallel store.
    const key = hash(JSON.stringify([this.binding.executionHostId, this.binding.providerId]))
    this.filePath = join(userDataPath, 'plugin-environment-recipes', `${key}.json`)
  }

  async snapshot(): Promise<EnvironmentRecipeJournal> {
    return this.read()
  }

  async begin(input: EnvironmentRecipeRequest): Promise<{
    kind: 'started' | 'recorded'
    operation: EnvironmentRecipeJournalOperation
  }> {
    const request = validatedRequest(structuredClone(input))
    this.requireProvider(request)
    return withFileTransactionLock(this.filePath, async () => {
      const journal = await this.read()
      const existing = journal.operations.find((entry) => entry.operationId === request.operationId)
      if (existing) {
        this.requireRequest(existing, request)
        return { kind: 'recorded', operation: existing }
      }
      if (journal.operations.some((entry) => entry.status === 'pending')) {
        throw new Error('An environment operation is already pending')
      }
      if (
        request.action !== 'list' &&
        journal.operations.some(
          (entry) => entry.status === 'unverifiable' && entry.action !== 'list'
        )
      ) {
        throw new Error(
          'An uncertain environment mutation must be reconciled before another mutation'
        )
      }
      if ('resourceId' in request) {
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
      this.write(journal)
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
    return withFileTransactionLock(this.filePath, async () => {
      const journal = await this.read()
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
      if (response && response.kind !== 'error') {
        const resources = response.kind === 'inventory' ? response.resources : [response.resource]
        const merged = new Map(journal.resources.map((resource) => [resource.id, resource]))
        for (const resource of resources) {
          merged.set(resource.id, resource)
        }
        // Missing rows in a page never prove deletion, even on the last page.
        journal.resources = [...merged.values()]
      }
      const operation: EnvironmentRecipeJournalOperation = {
        ...existing,
        status: outcome.kind,
        resultDigest,
        finishedAt: Math.max(Date.now(), existing.startedAt),
        ...('reason' in outcome ? { reason: outcome.reason } : {})
      }
      journal.operations[index] = operation
      this.write(journal)
      return operation
    })
  }

  private requireProvider(request: EnvironmentRecipeRequest): void {
    if (request.providerId !== this.binding.providerId) {
      throw new Error('Environment request names another journal owner')
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

  private async read(): Promise<EnvironmentRecipeJournal> {
    let raw: string
    try {
      raw = (
        await readNodeFileWithinLimit(this.filePath, ENVIRONMENT_RECIPE_JOURNAL_BYTES, {
          regularFileOnly: true
        })
      ).buffer.toString('utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, binding: { ...this.binding }, resources: [], operations: [] }
      }
      throw error
    }
    assertJsonTextStructureWithinLimits(raw, { nestingDepth: 16, structuralTokens: 512 * 1024 })
    const journal = environmentRecipeJournalSchema.parse(JSON.parse(raw))
    if (JSON.stringify(journal.binding) !== JSON.stringify(this.binding)) {
      throw new Error('Environment journal belongs to different source, recipe or execution host')
    }
    return journal
  }

  private write(journal: EnvironmentRecipeJournal): void {
    const parsed = environmentRecipeJournalSchema.parse(journal)
    const { serialized } = stringifyJsonWithinByteLimit(parsed, ENVIRONMENT_RECIPE_JOURNAL_BYTES)
    if (!writeSecureFile(this.filePath, serialized, { durable: true })) {
      throw new Error('Environment journal permissions could not be restricted')
    }
  }
}
