import { z } from 'zod'
import { pluginEnvironmentProviderReviewSchema } from './plugin-environment-provider-api'
import type { EnvironmentRecipeJournalBinding } from './plugin-environment-recipe-journal'
import type { EnvironmentRecipeResource } from '../environment-recipe-protocol'

export const pluginEnvironmentProviderMigrationPrepareSchema = z.strictObject({
  review: pluginEnvironmentProviderReviewSchema,
  queryId: z.uuid()
})
export const pluginEnvironmentProviderMigrationCommitSchema = z.strictObject({ ticketId: z.uuid() })
export type PluginEnvironmentProviderMigrationPreview = {
  ticketId: string
  expiresAt: number
  providerId: string
  previousBinding: EnvironmentRecipeJournalBinding
  nextBinding: EnvironmentRecipeJournalBinding
  previousResources: EnvironmentRecipeResource[]
  currentResources: EnvironmentRecipeResource[]
  unresolvedOperationIds: string[]
}
