import type {
  PluginEnvironmentProviderEntry,
  PluginEnvironmentProviderConfiguration
} from '../../shared/plugins/plugin-environment-provider-api'
import { pluginEnvironmentProviderReviewSchema } from '../../shared/plugins/plugin-environment-provider-api'
import {
  environmentRecipeDeclaredActions,
  environmentRecipeProviderId
} from '../../shared/plugins/plugin-environment-recipe-artifact'
import { pluginEnvironmentRecipePreview } from '../../shared/plugins/plugin-environment-recipe-preview'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { PluginService } from './plugin-service'
import { environmentRecipeDigest } from './plugin-environment-recipe-execution'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { buildPluginEnvironmentRecipeBinding } from './plugin-environment-recipe-binding'
import { resolveReviewedPluginEnvironmentProvider } from './plugin-environment-provider-release'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'
import { PluginEnvironmentRecipeJournalStore } from './plugin-environment-recipe-journal-store'

export class PluginEnvironmentProviderCatalog {
  private readonly contexts: PluginEnvironmentProviderContextStore
  constructor(
    private readonly options: {
      service: Pick<PluginService, 'whenReady' | 'contentPacks'>
      userDataPath: string
      isCurrent(): boolean
      onChanged?(providerId: string): void
    }
  ) {
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
  }
  async list(): Promise<PluginEnvironmentProviderEntry[]> {
    await this.options.service.whenReady()
    if (!this.options.isCurrent()) {
      return []
    }
    const registered = this.options.service.contentPacks.environmentRecipes.list()
    const entries = await mapWithConcurrency(
      registered,
      4,
      async (selected): Promise<PluginEnvironmentProviderEntry | null> => {
        const { pluginKey } = selected
        const providerId = environmentRecipeProviderId(pluginKey, selected.recipe)
        const authority =
          await this.options.service.contentPacks.environmentRecipes.resolveAuthority(providerId)
        if (!authority?.plugin.reviewRevision) {
          throw new Error('Environment provider release is unavailable')
        }
        const recipe = authority.registration.recipe
        const review = {
          providerId,
          consentFingerprint: authority.plugin.consentFingerprint,
          reviewRevision: authority.plugin.reviewRevision,
          recipeDigest: environmentRecipeDigest(recipe)
        }
        let configuration: PluginEnvironmentProviderConfiguration = { status: 'unconfigured' }
        try {
          const configured = await this.contexts.read(providerId)
          if (configured) {
            if (configured.binding.journalId) {
              await new PluginEnvironmentRecipeJournalFile(
                this.options.userDataPath,
                configured.binding
              ).read()
            }
            const binding = buildPluginEnvironmentRecipeBinding(
              authority.plugin,
              recipe,
              configured.binding.contextId,
              configured.binding.journalId
            )
            configuration = {
              status:
                JSON.stringify(binding) === JSON.stringify(configured.binding)
                  ? 'ready'
                  : 'migration-required',
              contextId: configured.binding.contextId
            }
          }
        } catch {
          configuration = { status: 'unavailable' }
        }
        if (recipe.protocolVersion !== 2) {
          configuration = { status: 'unavailable' }
        }
        if (!authority.isCurrent()) {
          return null
        }
        return {
          executionHostId: 'local',
          providerId,
          pluginKey,
          name: recipe.name,
          description: recipe.description,
          lifetime: recipe.lifetime,
          protocolVersion: recipe.protocolVersion ?? 1,
          actions: environmentRecipeDeclaredActions(recipe),
          recoverySupported: Boolean(recipe.recovery),
          createFields: structuredClone(recipe.createFields),
          commands: pluginEnvironmentRecipePreview(pluginKey, recipe).commands,
          review,
          configuration
        }
      }
    )
    return entries.filter((entry) => entry !== null)
  }

  async configure(input: unknown): Promise<PluginEnvironmentProviderEntry[]> {
    const review = pluginEnvironmentProviderReviewSchema.parse(input)
    if (!this.options.isCurrent()) {
      throw new Error('Environment host has stopped')
    }
    const authority = await resolveReviewedPluginEnvironmentProvider(this.options.service, review)
    const configured = await this.contexts.read(review.providerId)
    const binding = buildPluginEnvironmentRecipeBinding(
      authority.plugin,
      authority.registration.recipe,
      review.contextId,
      configured?.binding.journalId
    )
    await new PluginEnvironmentRecipeJournalStore(this.options.userDataPath, binding).snapshot()
    if (!authority.isCurrent()) {
      throw new Error('Environment provider changed during configuration')
    }
    await this.contexts.configure(binding)
    this.options.onChanged?.(review.providerId)
    return this.list()
  }
}
