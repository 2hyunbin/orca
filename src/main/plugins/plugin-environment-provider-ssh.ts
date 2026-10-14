import {
  isEnvironmentRecipeOperationUnresolved,
  isEnvironmentRecipeResourceInventoryUnconfirmed
} from '../../shared/plugins/plugin-environment-recipe-journal'
import {
  PluginEnvironmentProviderSshReviews,
  type PluginEnvironmentProviderSshOptions
} from './plugin-environment-provider-ssh-reviews'
import { PluginEnvironmentProviderSshConnections } from './plugin-environment-provider-ssh-connections'
import type { SshTarget } from '../../shared/ssh-types'
import type { PluginEnvironmentProviderReview } from '../../shared/plugins/plugin-environment-provider-api'
import {
  pluginEnvironmentSshBindingSchema,
  type PluginEnvironmentSshBinding
} from '../../shared/plugins/plugin-environment-ssh-binding'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'

/** Fresh inventory is reviewed separately from SSH credentials and host-key trust. */
export class PluginEnvironmentProviderSsh {
  private readonly connections = new PluginEnvironmentProviderSshConnections()
  private readonly contexts: PluginEnvironmentProviderContextStore
  private readonly reviews: PluginEnvironmentProviderSshReviews
  private readonly lifetime = new AbortController()
  private readonly leases = new Map<
    string,
    { owner: PluginEnvironmentSshBinding; controller: AbortController; signal: AbortSignal }
  >()

  constructor(private readonly options: PluginEnvironmentProviderSshOptions) {
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
    const retireTarget = options.retireTarget
    this.reviews = new PluginEnvironmentProviderSshReviews(
      {
        ...options,
        retireTarget: retireTarget
          ? async (target) => {
              const owner = target.environmentProvider
              if (!owner) {
                throw new Error('The saved target has no environment provider owner')
              }
              this.invalidateProvider(owner.binding.providerId, owner.resourceId)
              await retireTarget(target)
            }
          : undefined
      },
      this.lifetime,
      (review, owner) => this.requireCurrent(review, owner)
    )
  }
  prepare(...args: Parameters<PluginEnvironmentProviderSshReviews['prepare']>) {
    return this.options.track
      ? this.options.track(() => this.reviews.prepare(...args))
      : this.reviews.prepare(...args)
  }
  save(...args: Parameters<PluginEnvironmentProviderSshReviews['save']>) {
    const save = async () => {
      const target = await this.reviews.save(...args)
      this.connections.remember(args[0], target)
      return target
    }
    return this.options.track ? this.options.track(save) : save()
  }
  revokeOwner(ownerKey: string): void {
    this.connections.revokeOwner(ownerKey)
    this.reviews.revokeOwner(ownerKey)
  }
  discard(ownerKey: string, ticketId: string): boolean {
    return this.reviews.discard(ownerKey, ticketId)
  }

  connectSavedTarget(ownerKey: string, targetId: string, generation: number, signal: AbortSignal) {
    const connect = () =>
      this.connections.connect(
        ownerKey,
        targetId,
        generation,
        AbortSignal.any([signal, this.lifetime.signal]),
        (target) => this.authorize(target)
      )
    return this.options.track ? this.options.track(connect) : connect()
  }

  async authorize(target: SshTarget) {
    const owner = pluginEnvironmentSshBindingSchema.parse(target.environmentProvider)
    if (owner.binding.executionHostId !== 'local') {
      throw new Error('SSH connection belongs to another execution host')
    }
    await this.options.service.whenReady()
    const authority = await this.options.service.contentPacks.environmentRecipes.resolveAuthority(
      owner.binding.providerId
    )
    if (!authority?.plugin.reviewRevision) {
      throw new Error('The environment provider requires current approval before SSH connection')
    }
    const review = {
      providerId: owner.binding.providerId,
      contextId: owner.binding.contextId,
      consentFingerprint: authority.plugin.consentFingerprint,
      reviewRevision: authority.plugin.reviewRevision,
      recipeDigest: environmentRecipeDigest(authority.registration.recipe)
    }
    const current = await this.requireCurrent(review, owner)
    const store = getSshTargetRegistryStore()
    const matchesRegistration = (): boolean => {
      const saved = store?.getTarget(target.id)
      return Boolean(
        saved &&
        saved.generation === target.generation &&
        JSON.stringify(saved.environmentProvider) === JSON.stringify(owner) &&
        saved.host === target.host &&
        saved.port === target.port &&
        saved.username === target.username &&
        saved.configHost === target.configHost
      )
    }
    if (!store || !matchesRegistration()) {
      throw new Error('The saved provider SSH registration changed')
    }
    const expected = owner.connection
    if (
      target.host !== expected.host ||
      target.port !== expected.port ||
      target.username !== expected.username ||
      (target.configHost ?? target.host) !== (expected.configHost ?? expected.host)
    ) {
      throw new Error('The saved SSH endpoint differs from the reviewed provider connection')
    }
    const key = JSON.stringify(owner)
    let lease = this.leases.get(key)
    if (!lease || lease.signal.aborted) {
      lease?.controller.abort()
      const controller = new AbortController()
      lease = {
        owner,
        controller,
        signal: AbortSignal.any([authority.signal, this.lifetime.signal, controller.signal])
      }
      this.leases.set(key, lease)
    }
    const signal = lease.signal
    return {
      signal,
      isCurrent: () =>
        current.isCurrent() &&
        matchesRegistration() &&
        authority.isCurrent() &&
        !signal.aborted &&
        !this.options.isMutationPending(owner.binding.providerId, owner.resourceId)
    }
  }

  private async requireCurrent(
    review: PluginEnvironmentProviderReview,
    owner: PluginEnvironmentSshBinding
  ) {
    if (
      this.options.isMutationPending(review.providerId, owner.resourceId) ||
      this.lifetime.signal.aborted
    ) {
      throw new Error('An environment machine change is in progress')
    }
    const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const context = await this.contexts.open(review.providerId)
    if (!context || JSON.stringify(context.record.binding) !== JSON.stringify(owner.binding)) {
      throw new Error('The provider account or source no longer owns this SSH connection')
    }
    const journal = await new PluginEnvironmentRecipeJournalStore(
      this.options.userDataPath,
      owner.binding
    ).snapshot()
    if (
      journal.operations.some(
        (op) =>
          isEnvironmentRecipeOperationUnresolved(op) ||
          isEnvironmentRecipeResourceInventoryUnconfirmed(op, owner.resourceId)
      )
    ) {
      throw new Error('An unresolved environment operation prevents SSH connection')
    }
    const resource = journal.resources.find((entry) => entry.id === owner.resourceId)
    if (
      !resource ||
      resource.state !== 'running' ||
      resource.revision !== owner.resourceRevision ||
      JSON.stringify(resource.connection) !== JSON.stringify(owner.connection)
    ) {
      throw new Error('The saved provider machine is no longer current and running')
    }
    if (!context.isCurrent() || !authority.isCurrent()) {
      throw new Error('Environment connection authority changed')
    }
    return {
      isCurrent: () =>
        context.isCurrent() &&
        authority.isCurrent() &&
        !this.lifetime.signal.aborted &&
        !this.options.isMutationPending(review.providerId, owner.resourceId)
    }
  }

  invalidateProvider(providerId: string, resourceId?: string): void {
    for (const [key, lease] of this.leases) {
      if (
        lease.owner.binding.providerId === providerId &&
        (resourceId === undefined || lease.owner.resourceId === resourceId)
      ) {
        lease.controller.abort()
        this.leases.delete(key)
      }
    }
  }

  async reconcile(providerId: string): Promise<void> {
    const selected = [...this.leases].filter(
      ([, entry]) => entry.owner.binding.providerId === providerId
    )
    if (!selected.length) {
      return
    }
    try {
      const journal = await new PluginEnvironmentRecipeJournalStore(
        this.options.userDataPath,
        selected[0]![1].owner.binding
      ).snapshot()
      for (const [key, lease] of selected) {
        const uncertain = journal.operations.some(
          (op) =>
            (isEnvironmentRecipeOperationUnresolved(op) &&
              op.resourceId === lease.owner.resourceId) ||
            isEnvironmentRecipeResourceInventoryUnconfirmed(op, lease.owner.resourceId)
        )
        const resource = journal.resources.find((entry) => entry.id === lease.owner.resourceId)
        if (
          uncertain ||
          !resource ||
          resource.state !== 'running' ||
          resource.revision !== lease.owner.resourceRevision ||
          JSON.stringify(resource.connection) !== JSON.stringify(lease.owner.connection)
        ) {
          lease.controller.abort()
          if (this.leases.get(key) === lease) {
            this.leases.delete(key)
          }
        }
      }
    } catch {
      this.invalidateProvider(providerId)
    }
  }

  dispose(): void {
    this.lifetime.abort()
    for (const lease of this.leases.values()) {
      lease.controller.abort()
    }
    this.leases.clear()
    this.connections.clear()
    this.reviews.dispose()
  }
}
