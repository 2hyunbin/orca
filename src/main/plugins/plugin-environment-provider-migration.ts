import { createHash, randomUUID } from 'node:crypto'
import type { PluginService } from './plugin-service'
import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  type PluginEnvironmentProviderMigrationPreview
} from '../../shared/plugins/plugin-environment-provider-migration-api'
import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import {
  environmentRecipeJournalSchema,
  isEnvironmentRecipeOperationUnresolved,
  type EnvironmentRecipeJournal
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import { createPluginEnvironmentProviderControlContext } from './plugin-environment-provider-control-context'
import { inspectPluginEnvironmentMigrationInventory } from './plugin-environment-provider-migration-inventory'
import type { EnvironmentAdapterRuntime } from './plugin-environment-adapter-launch'
import { withFileTransactionLock } from '../file-transaction-lock'

function digest(journal: EnvironmentRecipeJournal): string {
  return createHash('sha256').update(JSON.stringify(journal)).digest('hex')
}
type Ticket = {
  ownerKey: string
  controller: AbortController
  review: PluginEnvironmentProviderReview
  previous: EnvironmentRecipeJournal
  previousDigest: string
  next: EnvironmentRecipeJournal
  preview: PluginEnvironmentProviderMigrationPreview
}
export class PluginEnvironmentProviderMigration {
  private readonly contexts: PluginEnvironmentProviderContextStore
  private readonly tickets = new Map<string, Ticket>()
  private readonly consuming = new Set<Ticket>()
  constructor(
    private readonly options: {
      service: Pick<PluginService, 'whenReady' | 'contentPacks'>
      userDataPath: string
      launchEnvironment(): Promise<NodeJS.ProcessEnv>
      signal: AbortSignal
      retireConnections(providerId: string): Promise<void>
      onChanged?(providerId: string): void
      adapterRuntime?: EnvironmentAdapterRuntime
    }
  ) {
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
  }

  async prepare(
    ownerKey: string,
    input: { review: PluginEnvironmentProviderReview; queryId: string },
    signal?: AbortSignal
  ): Promise<PluginEnvironmentProviderMigrationPreview> {
    const { review } = pluginEnvironmentProviderMigrationPrepareSchema.parse(structuredClone(input))
    this.prune()
    for (const [key, ticket] of this.tickets) {
      if (ticket.ownerKey === ownerKey && ticket.review.providerId === review.providerId) {
        this.tickets.delete(key)
      }
    }
    if (this.tickets.size >= 16 || this.options.signal.aborted || signal?.aborted) {
      throw new Error('Provider migration review is unavailable')
    }
    const context = await this.contexts.open(review.providerId)
    if (!context) {
      throw new Error('Set up this provider account before migrating it')
    }
    const previous = await new PluginEnvironmentRecipeJournalFile(
      this.options.userDataPath,
      context.record.binding
    ).read()
    const unresolved = previous.operations.filter(
      (op) => isEnvironmentRecipeOperationUnresolved(op) && op.action !== 'list'
    )
    if (review.contextId !== previous.binding.contextId && unresolved.length) {
      throw new Error('Resolve the original account’s machine changes before switching accounts')
    }
    const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const nextBinding = buildPluginEnvironmentRecipeBinding(
      authority.plugin,
      authority.registration.recipe,
      review.contextId,
      randomUUID()
    )
    const control = await createPluginEnvironmentProviderControlContext({
      userDataPath: this.options.userDataPath,
      binding: nextBinding,
      launchEnvironment: this.options.launchEnvironment,
      signal: this.options.signal,
      previewId: nextBinding.journalId,
      isCurrent: () => context.isCurrent() && authority.isCurrent() && !this.options.signal.aborted
    })
    const inspected = await inspectPluginEnvironmentMigrationInventory({
      review,
      authority,
      control,
      signal,
      adapterRuntime: this.options.adapterRuntime,
      userDataPath: this.options.userDataPath
    })
    if (
      !context.isCurrent() ||
      !authority.isCurrent() ||
      signal?.aborted ||
      this.options.signal.aborted ||
      this.tickets.size >= 16
    ) {
      throw new Error('Provider configuration changed during migration review')
    }
    const sameAccount = previous.binding.contextId === nextBinding.contextId
    const next = environmentRecipeJournalSchema.parse({
      version: 1,
      binding: nextBinding,
      resources: inspected.resources,
      operations: [
        ...(sameAccount
          ? previous.operations.map((op) => ({
              ...op,
              originBinding: op.originBinding ?? previous.binding
            }))
          : []),
        ...inspected.operations
      ],
      previousBindings: [
        ...(previous.previousBindings ?? []),
        { binding: previous.binding, archivedAt: Date.now() }
      ]
    })
    const preview = {
      ticketId: randomUUID(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      providerId: review.providerId,
      previousBinding: previous.binding,
      nextBinding,
      previousResources: previous.resources,
      currentResources: inspected.resources,
      unresolvedOperationIds: sameAccount ? unresolved.map((op) => op.operationId) : []
    }
    this.tickets.set(preview.ticketId, {
      ownerKey,
      controller: new AbortController(),
      review,
      previous,
      previousDigest: digest(previous),
      next,
      preview: structuredClone(preview)
    })
    return structuredClone(preview)
  }

  providerFor(ownerKey: string, ticketId: string): string {
    const ticket = this.tickets.get(ticketId)
    if (!ticket || ticket.ownerKey !== ownerKey || ticket.preview.expiresAt <= Date.now()) {
      throw new Error('Migration review is unavailable')
    }
    return ticket.review.providerId
  }

  async commit(ownerKey: string, ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId)
    if (
      !ticket ||
      ticket.ownerKey !== ownerKey ||
      ticket.preview.expiresAt <= Date.now() ||
      this.options.signal.aborted
    ) {
      throw new Error('The migration review is unavailable or expired')
    }
    this.tickets.delete(ticketId)
    this.consuming.add(ticket)
    try {
      const authority = await resolveReviewedPluginEnvironmentProvider(
        this.options.service,
        ticket.review
      )
      const expected = buildPluginEnvironmentRecipeBinding(
        authority.plugin,
        authority.registration.recipe,
        ticket.review.contextId,
        ticket.next.binding.journalId
      )
      if (JSON.stringify(expected) !== JSON.stringify(ticket.next.binding)) {
        throw new Error('Migration source changed')
      }
      const oldFile = new PluginEnvironmentRecipeJournalFile(
        this.options.userDataPath,
        ticket.previous.binding
      )
      await withFileTransactionLock(oldFile.filePath, async () => {
        if (digest(await oldFile.read()) !== ticket.previousDigest) {
          throw new Error('Saved inventory or operation history changed; review migration again')
        }
        const context = await this.contexts.open(ticket.review.providerId)
        if (
          !context ||
          JSON.stringify(context.record.binding) !== JSON.stringify(ticket.previous.binding)
        ) {
          throw new Error('Migration no longer owns the reviewed account selection')
        }
        const isCurrent = (): boolean =>
          authority.isCurrent() &&
          context.isCurrent() &&
          !ticket.controller.signal.aborted &&
          !this.options.signal.aborted
        if (!isCurrent()) {
          throw new Error('Migration approval or window authority changed')
        }
        await this.options.retireConnections(ticket.review.providerId)
        if (!isCurrent()) {
          throw new Error('Migration approval or window authority changed')
        }
        new PluginEnvironmentRecipeJournalFile(
          this.options.userDataPath,
          ticket.next.binding
        ).write(ticket.next)
        await this.contexts.replace(ticket.previous.binding, ticket.next.binding, { isCurrent })
      })
      this.options.onChanged?.(ticket.review.providerId)
    } finally {
      this.consuming.delete(ticket)
    }
  }
  revokeOwner(ownerKey: string): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.ownerKey === ownerKey) {
        ticket.controller.abort()
        this.tickets.delete(key)
      }
    }
    for (const ticket of this.consuming) {
      if (ticket.ownerKey === ownerKey) {
        ticket.controller.abort()
      }
    }
  }
  private prune(): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.preview.expiresAt <= Date.now()) {
        this.tickets.delete(key)
      }
    }
  }
  dispose(): void {
    for (const ticket of this.consuming) {
      ticket.controller.abort()
    }
    this.tickets.clear()
  }
}
