import {
  pluginEnvironmentProviderSavedHistorySchema,
  type PluginEnvironmentProviderSavedEntry,
  type PluginEnvironmentProviderSavedHistory
} from '../../shared/plugins/plugin-environment-provider-saved-history-api'
import type { PluginService } from './plugin-service'
import { environmentRecipeProviderId } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { PluginEnvironmentProviderContextStore } from './plugin-environment-provider-context-store'
import { PluginEnvironmentRecipeJournalFile } from './plugin-environment-recipe-journal-file'

export class PluginEnvironmentProviderSavedHistoryStore {
  private readonly contexts: PluginEnvironmentProviderContextStore
  constructor(
    private readonly options: {
      service: Pick<PluginService, 'whenReady' | 'contentPacks'>
      userDataPath: string
      isCurrent(): boolean
    }
  ) {
    this.contexts = new PluginEnvironmentProviderContextStore(options.userDataPath)
  }

  async list(): Promise<PluginEnvironmentProviderSavedEntry[]> {
    await this.options.service.whenReady()
    this.requireCurrent()
    const records = await this.contexts.list()
    this.requireCurrent()
    const active = new Set(
      this.options.service.contentPacks.environmentRecipes
        .list()
        .map((entry) => environmentRecipeProviderId(entry.pluginKey, entry.recipe))
    )
    return records
      .filter((entry) => !active.has(entry.binding.providerId))
      .map((entry) => ({
        executionHostId: 'local',
        providerId: entry.binding.providerId,
        contextId: entry.binding.contextId,
        configuredAt: entry.createdAt
      }))
  }

  async read(input: unknown): Promise<PluginEnvironmentProviderSavedHistory> {
    const { providerId, offset } = pluginEnvironmentProviderSavedHistorySchema.parse(input)
    this.requireCurrent()
    const context = await this.contexts.open(providerId)
    if (!context) {
      throw new Error('No saved provider account exists')
    }
    const current = await new PluginEnvironmentRecipeJournalFile(
      this.options.userDataPath,
      context.record.binding
    ).read()
    const previous = offset === 0 ? null : current.previousBindings?.at(-offset)
    if (offset !== 0 && !previous) {
      throw new Error('No saved configuration exists at this offset')
    }
    const snapshot = previous
      ? await new PluginEnvironmentRecipeJournalFile(
          this.options.userDataPath,
          previous.binding
        ).read()
      : current
    this.requireCurrent()
    if (!context.isCurrent()) {
      throw new Error('Saved provider selection changed during reading')
    }
    return {
      snapshot,
      previousCount: current.previousBindings?.length ?? 0,
      archivedAt: previous?.archivedAt ?? null
    }
  }

  private requireCurrent(): void {
    if (!this.options.isCurrent()) {
      throw new Error('Environment host has stopped')
    }
  }
}
