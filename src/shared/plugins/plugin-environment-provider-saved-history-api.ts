import { z } from 'zod'
import { environmentRecipeJournalBindingSchema } from './plugin-environment-recipe-journal'
import type { EnvironmentRecipeJournal } from './plugin-environment-recipe-journal'

export const pluginEnvironmentProviderSavedHistorySchema = z.strictObject({
  providerId: environmentRecipeJournalBindingSchema.shape.providerId,
  offset: z.number().int().min(0).max(128).default(0)
})

export type PluginEnvironmentProviderSavedEntry = {
  executionHostId: 'local'
  providerId: string
  contextId: string
  configuredAt: number
}

export type PluginEnvironmentProviderSavedHistory = {
  snapshot: EnvironmentRecipeJournal
  previousCount: number
  archivedAt: number | null
}
