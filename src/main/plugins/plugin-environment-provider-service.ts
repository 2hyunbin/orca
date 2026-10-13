import { pluginEnvironmentProviderHistorySchema } from '../../shared/plugins/plugin-environment-provider-history-api'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { PluginEnvironmentProviderMigration } from './plugin-environment-provider-migration'
import type { SshTarget } from '../../shared/ssh-types'
import { createPluginEnvironmentProviderControlContext } from './plugin-environment-provider-control-context'
import {
  pluginEnvironmentProviderMigrationPrepareSchema,
  pluginEnvironmentProviderMigrationCommitSchema
} from '../../shared/plugins/plugin-environment-provider-migration-api'
import { PluginEnvironmentProviderCatalog } from './plugin-environment-provider-catalog'
import {
  pluginEnvironmentProviderRecoverSchema,
  type PluginEnvironmentProviderRecoverRequest
} from '../../shared/plugins/plugin-environment-provider-recovery-api'
import {
  isEnvironmentRecipeOperationUnresolved,
  isEnvironmentRecipeResourceInventoryUnconfirmed
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { randomUUID } from 'node:crypto'
import { environmentRecipeRequestSchema } from '../../shared/environment-recipe-protocol'
import { pluginEnvironmentProviderReviewSchema } from '../../shared/plugins/plugin-environment-provider-api'
import { environmentRecipeDeclaredActions } from '../../shared/plugins/plugin-environment-recipe-artifact'
import type { PluginService } from './plugin-service'
import type { PluginServiceOptions } from './plugin-service-options'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { PluginEnvironmentRecipeHost } from './plugin-environment-recipe-host'
import { PluginEnvironmentProviderSsh } from './plugin-environment-provider-ssh'
import { PluginEnvironmentProviderSavedHistoryStore } from './plugin-environment-provider-saved-history'

export class PluginEnvironmentProviderService {
  private readonly migration: PluginEnvironmentProviderMigration
  private readonly catalog: PluginEnvironmentProviderCatalog
  private readonly saved: PluginEnvironmentProviderSavedHistoryStore
  private readonly host: PluginEnvironmentRecipeHost
  private readonly active = new Map<
    object,
    { providerId: string; mutation: boolean; resourceId?: string; allResources?: boolean }
  >()
  readonly ssh: PluginEnvironmentProviderSsh
  private readonly contexts: PluginEnvironmentProviderContextStore
  private readonly lifetime = new AbortController()

  constructor(
    private readonly options: {
      service: Pick<PluginService, 'whenReady' | 'contentPacks'>
      userDataPath: string
      launchEnvironment(): Promise<NodeJS.ProcessEnv>
      onChanged?(providerId: string): void
      retireConnections?(providerId: string, resourceId?: string): Promise<void>
      retireTarget?(target: SshTarget): Promise<void>
    }
  ) {
    this.catalog = new PluginEnvironmentProviderCatalog({
      ...options,
      isCurrent: () => !this.lifetime.signal.aborted
    })
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
    this.saved = new PluginEnvironmentProviderSavedHistoryStore({
      ...options,
      isCurrent: () => !this.lifetime.signal.aborted
    })
    this.ssh = new PluginEnvironmentProviderSsh({
      service: options.service,
      userDataPath: options.userDataPath,
      onTargetSaved: options.onChanged,
      retireTarget: options.retireTarget,
      isMutationPending: (providerId, resourceId) =>
        [...this.active.values()].some(
          (operation) =>
            operation.providerId === providerId &&
            operation.mutation &&
            (resourceId === undefined ||
              operation.allResources ||
              operation.resourceId === resourceId)
        ),
      inventory: (review, cursor, signal) =>
        this.execute(
          review,
          {
            protocolVersion: 2,
            contextId: review.contextId,
            providerId: review.providerId,
            operationId: randomUUID(),
            action: 'list',
            ...(cursor ? { cursor } : {})
          },
          signal
        )
    })
    this.migration = new PluginEnvironmentProviderMigration({
      ...options,
      signal: this.lifetime.signal,
      retireConnections: async (providerId) => {
        for (const [slot, operation] of this.active) {
          if (operation.providerId === providerId) {
            this.active.set(slot, { ...operation, mutation: true, allResources: true })
          }
        }
        this.ssh.invalidateProvider(providerId)
        await options.retireConnections?.(providerId)
      }
    })
    this.host = new PluginEnvironmentRecipeHost({
      service: options.service,
      userDataPath: options.userDataPath,
      controlContext: async (providerId) => {
        const context = await this.contexts.open(providerId)
        if (!context || this.lifetime.signal.aborted) {
          return null
        }
        return createPluginEnvironmentProviderControlContext({
          userDataPath: options.userDataPath,
          binding: context.record.binding,
          launchEnvironment: options.launchEnvironment,
          signal: this.lifetime.signal,
          isCurrent: () => !this.lifetime.signal.aborted && context.isCurrent()
        })
      }
    })
  }

  static forService(
    service: PluginService,
    options: PluginServiceOptions,
    onChanged?: (providerId: string) => void
  ): PluginEnvironmentProviderService {
    return new PluginEnvironmentProviderService({
      service,
      onChanged,
      retireConnections: options.retireEnvironmentProviderConnections,
      retireTarget: options.retireEnvironmentProviderSshTarget,
      userDataPath: options.userDataPath,
      launchEnvironment:
        options.getEnvironmentRecipeLaunchEnvironment ?? (async () => ({ ...process.env }))
    })
  }

  async snapshot(input: Parameters<PluginEnvironmentRecipeHost['snapshot']>[0]) {
    const review = pluginEnvironmentProviderReviewSchema.parse(input)
    await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const configured = await this.contexts.read(review.providerId)
    if (!configured || configured.binding.contextId !== review.contextId) {
      throw new Error('Environment provider has no current host-selected account context')
    }
    return new PluginEnvironmentRecipeJournalStore(
      this.options.userDataPath,
      configured.binding
    ).snapshot()
  }

  async execute(...args: Parameters<PluginEnvironmentRecipeHost['execute']>) {
    const review = pluginEnvironmentProviderReviewSchema.parse(args[0])
    const request = environmentRecipeRequestSchema.parse(args[1])
    const providerId = review.providerId
    if (request.providerId !== providerId || request.contextId !== review.contextId) {
      throw new Error('Environment operation names another provider account')
    }
    if (
      this.active.size >= 8 ||
      [...this.active.values()].some((entry) => entry.providerId === providerId)
    ) {
      throw new Error('An environment operation is already running on this host or provider')
    }
    const slot = {}
    this.active.set(slot, { providerId, mutation: false })
    try {
      const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
      if (
        !environmentRecipeDeclaredActions(authority.registration.recipe).includes(request.action)
      ) {
        throw new Error('The environment provider does not support this action')
      }
      const configured = await this.contexts.open(providerId)
      const expected = buildPluginEnvironmentRecipeBinding(
        authority.plugin,
        authority.registration.recipe,
        review.contextId,
        configured?.record.binding.journalId
      )
      if (
        !configured ||
        JSON.stringify(configured.record.binding) !== JSON.stringify(expected) ||
        !configured.isCurrent() ||
        !authority.isCurrent()
      ) {
        throw new Error('The environment provider account requires configuration or migration')
      }
      const journal = await new PluginEnvironmentRecipeJournalStore(
        this.options.userDataPath,
        expected
      ).snapshot()
      if (journal.operations.some((entry) => entry.operationId === request.operationId)) {
        return await this.host.execute(review, request, args[2])
      }
      if (request.action !== 'list') {
        if (journal.operations.some((op) => isEnvironmentRecipeOperationUnresolved(op))) {
          throw new Error('An unresolved environment operation prevents another machine change')
        }
        const resourceId = 'resourceId' in request ? request.resourceId : undefined
        if (resourceId) {
          if (
            journal.operations.some((entry) =>
              isEnvironmentRecipeResourceInventoryUnconfirmed(entry, resourceId)
            )
          ) {
            throw new Error('Refresh inventory before changing the recovered machine')
          }
          const resource = journal.resources.find((entry) => entry.id === resourceId)
          if (
            !resource ||
            !('expectedRevision' in request) ||
            resource.revision !== request.expectedRevision ||
            resource.state === 'deleted'
          ) {
            throw new Error('The selected environment resource or revision is no longer current')
          }
          this.active.set(slot, { providerId, mutation: true, resourceId })
          this.ssh.invalidateProvider(providerId, resourceId)
          await this.options.retireConnections?.(providerId, resourceId)
        } else {
          this.active.set(slot, { providerId, mutation: true })
        }
      }
      return await this.host.execute(review, request, args[2])
    } finally {
      this.active.delete(slot)
      await this.ssh.reconcile(providerId)
      this.options.onChanged?.(providerId)
    }
  }

  async recover(input: PluginEnvironmentProviderRecoverRequest, signal?: AbortSignal) {
    const parsed = pluginEnvironmentProviderRecoverSchema.parse(structuredClone(input))
    const providerId = parsed.review.providerId
    if (
      this.active.size >= 8 ||
      [...this.active.values()].some((entry) => entry.providerId === providerId)
    ) {
      throw new Error('An environment operation is already running on this host or provider')
    }
    const slot = {}
    this.active.set(slot, { providerId, mutation: false })
    try {
      return await this.host.recover(parsed, signal)
    } finally {
      this.active.delete(slot)
      await this.ssh.reconcile(providerId)
      this.options.onChanged?.(providerId)
    }
  }

  async previousSnapshot(input: unknown) {
    const { review, offset } = pluginEnvironmentProviderHistorySchema.parse(input)
    const current = await this.snapshot(review)
    const previous = current.previousBindings?.at(-(offset + 1))
    if (!previous) {
      return null
    }
    const snapshot = await new PluginEnvironmentRecipeJournalFile(
      this.options.userDataPath,
      previous.binding
    ).read()
    return { archivedAt: previous.archivedAt, snapshot }
  }

  async prepareMigration(ownerKey: string, input: unknown, signal?: AbortSignal) {
    const request = pluginEnvironmentProviderMigrationPrepareSchema.parse(input)
    return this.migrateExclusive(request.review.providerId, () =>
      this.migration.prepare(ownerKey, request, signal)
    )
  }
  async commitMigration(ownerKey: string, input: unknown) {
    const { ticketId } = pluginEnvironmentProviderMigrationCommitSchema.parse(input)
    const providerId = this.migration.providerFor(ownerKey, ticketId)
    await this.migrateExclusive(providerId, () => this.migration.commit(ownerKey, ticketId))
    return this.list()
  }
  revokeMigrationOwner(ownerKey: string): void {
    this.migration.revokeOwner(ownerKey)
  }
  private async migrateExclusive<T>(providerId: string, run: () => Promise<T>): Promise<T> {
    if (
      this.active.size >= 8 ||
      [...this.active.values()].some((entry) => entry.providerId === providerId)
    ) {
      throw new Error('An environment operation is already running on this host or provider')
    }
    const slot = {}
    this.active.set(slot, { providerId, mutation: false })
    try {
      return await run()
    } finally {
      this.active.delete(slot)
      this.options.onChanged?.(providerId)
    }
  }

  list() {
    return this.catalog.list()
  }
  listSaved() {
    return this.saved.list()
  }
  savedSnapshot(input: unknown) {
    return this.saved.read(input)
  }
  configure(input: unknown) {
    return this.catalog.configure(input)
  }

  dispose(): void {
    this.lifetime.abort()
    this.ssh.dispose()
    this.migration.dispose()
  }
}
