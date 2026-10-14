import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from './plugin-install-lockfile'
import { isQualifiedPluginKey } from './plugin-manifest'
import { pluginMarketplaceGitSourceSchema } from './plugin-marketplace'
import { pluginReviewedMarketplaceUpdateSchema } from './plugin-reviewed-update'

export const pluginMarketplaceSourceIdSchema = z.string().regex(/^[0-9a-f]{32}$/)
export const pluginMarketplaceRemoveSchema = z.strictObject({
  sourceId: pluginMarketplaceSourceIdSchema
})
export const pluginMarketplaceRefreshSchema = z.strictObject({
  sourceId: pluginMarketplaceSourceIdSchema.optional()
})
export const pluginMarketplaceSelectionSchema = z.strictObject({
  marketplaceSourceId: pluginMarketplaceSourceIdSchema,
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
export const pluginMarketplaceInstallSchema = pluginMarketplaceSelectionSchema.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
})
export const pluginMarketplaceDataInstallSchema = pluginMarketplaceSelectionSchema.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
})
export const pluginInstalledSelectionSchema = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export const pluginMarketplaceManagementInputs = {
  listMarketplaces: z.strictObject({}),
  addMarketplace: pluginMarketplaceGitSourceSchema,
  removeMarketplace: pluginMarketplaceRemoveSchema,
  refreshMarketplaces: pluginMarketplaceRefreshSchema,
  listMarketplacePlugins: z.strictObject({}),
  previewMarketplacePlugin: pluginMarketplaceSelectionSchema,
  installMarketplacePlugin: pluginMarketplaceInstallSchema,
  installMarketplaceDataPlugin: pluginMarketplaceDataInstallSchema,
  approveMarketplaceUpdate: pluginReviewedMarketplaceUpdateSchema,
  previewMarketplaceUpdate: pluginInstalledSelectionSchema,
  rollbackMarketplacePlugin: pluginInstalledSelectionSchema
}
