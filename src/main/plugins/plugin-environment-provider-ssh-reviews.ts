import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { randomUUID } from 'node:crypto'
import type { SshTarget } from '../../shared/ssh-types'
import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import { pluginEnvironmentProviderReviewSchema } from '../../shared/plugins/plugin-environment-provider-api'
import {
  pluginEnvironmentSshBindingSchema,
  type PluginEnvironmentSshBinding
} from '../../shared/plugins/plugin-environment-ssh-binding'
import type { EnvironmentProviderSshPreview } from '../../shared/plugins/plugin-environment-provider-ssh-api'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import type { PluginService } from './plugin-service'
import type { JournaledEnvironmentRecipeResult } from '../../shared/plugins/plugin-environment-recipe-result'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'

type Ticket = {
  ownerKey: string
  controller: AbortController
  review: PluginEnvironmentProviderReview
  binding: PluginEnvironmentSshBinding
  preview: EnvironmentProviderSshPreview
}

export type PluginEnvironmentProviderSshOptions = {
  service: Pick<PluginService, 'whenReady' | 'contentPacks'>
  userDataPath: string
  inventory(
    review: PluginEnvironmentProviderReview,
    cursor: string | undefined,
    signal?: AbortSignal
  ): Promise<JournaledEnvironmentRecipeResult>
  isMutationPending(providerId: string, resourceId?: string): boolean
  onTargetSaved?(providerId: string): void
}

export class PluginEnvironmentProviderSshReviews {
  private readonly contexts: PluginEnvironmentProviderContextStore
  private readonly tickets = new Map<string, Ticket>()
  private readonly consuming = new Set<Ticket>()
  constructor(
    private readonly options: PluginEnvironmentProviderSshOptions,
    private readonly lifetime: { signal: AbortSignal },
    private readonly requireCurrent: (
      review: PluginEnvironmentProviderReview,
      binding: PluginEnvironmentSshBinding
    ) => Promise<{ isCurrent(): boolean }>
  ) {
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
  }
  async prepare(
    ownerKey: string,
    input: PluginEnvironmentProviderReview,
    resourceId: string,
    expectedRevision: string,
    signal?: AbortSignal
  ): Promise<EnvironmentProviderSshPreview> {
    const review = pluginEnvironmentProviderReviewSchema.parse(input)
    this.prune()
    if (this.tickets.size >= 32) {
      throw new Error('Too many SSH connection reviews are open')
    }
    const resource = await this.findCurrentResource(review, resourceId, signal)
    if (
      !resource ||
      resource.revision !== expectedRevision ||
      resource.state !== 'running' ||
      !resource.connection
    ) {
      throw new Error(
        'The selected machine or its SSH connection details changed; refresh inventory'
      )
    }
    const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const context = await this.contexts.open(review.providerId)
    const binding = pluginEnvironmentSshBindingSchema.parse({
      version: 1,
      binding: buildPluginEnvironmentRecipeBinding(
        authority.plugin,
        authority.registration.recipe,
        review.contextId,
        context?.record.binding.journalId
      ),
      resourceId: resource.id,
      resourceRevision: resource.revision,
      connection: resource.connection
    })
    if (
      !context ||
      JSON.stringify(context.record.binding) !== JSON.stringify(binding.binding) ||
      !context.isCurrent() ||
      !authority.isCurrent() ||
      signal?.aborted ||
      this.lifetime.signal.aborted ||
      this.options.isMutationPending(review.providerId) ||
      this.tickets.size >= 32
    ) {
      throw new Error('Environment provider connection authority changed during review')
    }
    const preview = {
      ticketId: randomUUID(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      providerId: review.providerId,
      contextId: review.contextId,
      resource: structuredClone(resource)
    }
    this.tickets.set(preview.ticketId, {
      ownerKey,
      controller: new AbortController(),
      review,
      binding,
      preview: structuredClone(preview)
    })
    return preview
  }

  async save(ownerKey: string, ticketId: string, identityFile?: string): Promise<SshTarget> {
    const ticket = this.tickets.get(ticketId)
    if (
      !ticket ||
      ticket.ownerKey !== ownerKey ||
      ticket.preview.expiresAt <= Date.now() ||
      this.lifetime.signal.aborted
    ) {
      throw new Error('The SSH connection review is unavailable or expired')
    }
    this.tickets.delete(ticketId)
    this.consuming.add(ticket)
    try {
      const store = getSshTargetRegistryStore()
      if (!store) {
        throw new Error('SSH connection management is unavailable on this host')
      }
      const current = await this.requireCurrent(ticket.review, ticket.binding)
      if (ticket.controller.signal.aborted || !current.isCurrent()) {
        throw new Error('Environment connection review changed')
      }
      const journal = await new PluginEnvironmentRecipeJournalFile(
        this.options.userDataPath,
        ticket.binding.binding
      ).read()
      const saved = store
        .listTargets()
        .find(
          (entry) =>
            entry.environmentProvider?.resourceId === ticket.binding.resourceId &&
            entry.environmentProvider.binding.providerId === ticket.review.providerId &&
            entry.environmentProvider.binding.contextId === ticket.review.contextId
        )
      const previous = journal.previousBindings?.find(
        (entry) =>
          JSON.stringify(entry.binding) === JSON.stringify(saved?.environmentProvider?.binding)
      )?.binding
      if (ticket.controller.signal.aborted || !current.isCurrent()) {
        throw new Error('Environment connection review changed')
      }
      const connection = ticket.binding.connection
      const target = store.upsertEnvironmentProviderTarget(
        ticket.binding,
        {
          label: ticket.preview.resource.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          ...(connection.configHost ? { configHost: connection.configHost } : {}),
          ...(identityFile ? { identityFile } : {})
        },
        previous
      )
      await store.getOrcadMigrationSource().flushPendingOrThrowAsync()
      this.options.onTargetSaved?.(ticket.review.providerId)
      return target
    } finally {
      this.consuming.delete(ticket)
    }
  }

  private async findCurrentResource(
    review: PluginEnvironmentProviderReview,
    id: string,
    signal?: AbortSignal
  ) {
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 16; page += 1) {
      const result = await this.options.inventory(review, cursor, signal)
      if (
        result.kind !== 'executed' ||
        result.result.kind !== 'completed' ||
        result.result.response.kind !== 'inventory'
      ) {
        throw new Error('The provider did not confirm current machine connection details')
      }
      const resource = result.result.response.resources.find((entry) => entry.id === id)
      if (resource) {
        return resource
      }
      cursor = result.result.response.nextCursor
      if (!cursor) {
        return undefined
      }
      if (seen.has(cursor)) {
        throw new Error('The provider repeated an inventory page')
      }
      seen.add(cursor)
    }
    throw new Error('The provider inventory exceeds the connection review page limit')
  }

  revokeOwner(ownerKey: string): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.ownerKey === ownerKey) {
        ticket.controller.abort()
        this.tickets.delete(id)
      }
    }
    for (const ticket of this.consuming) {
      if (ticket.ownerKey === ownerKey) {
        ticket.controller.abort()
      }
    }
  }
  private prune(): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.preview.expiresAt <= Date.now()) {
        this.tickets.delete(id)
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
