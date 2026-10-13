import { z } from 'zod'
import { pluginEnvironmentProviderReviewSchema } from './plugin-environment-provider-api'
import type { EnvironmentRecipeJournal } from './plugin-environment-recipe-journal'
export const pluginEnvironmentProviderHistorySchema = z.strictObject({
  review: pluginEnvironmentProviderReviewSchema,
  offset: z.number().int().min(0).max(127).default(0)
})
export type PluginEnvironmentProviderHistory = {
  archivedAt: number
  snapshot: EnvironmentRecipeJournal
} | null
