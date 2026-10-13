import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN, PLUGIN_CONTENT_HASH_PATTERN } from './plugin-install-lockfile'
import { isQualifiedPluginKey } from './plugin-manifest'

export const pluginReviewedMarketplaceUpdateSchema = z.strictObject({
  marketplaceSourceId: z.string().min(1).max(256),
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  pluginKey: z.string().refine(isQualifiedPluginKey),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  contentHash: z.string().regex(PLUGIN_CONTENT_HASH_PATTERN),
  reviewedFingerprint: z.string().min(1).max(256),
  reviewedRevision: z.string().min(1).max(256),
  reviewedEnvironmentRecipeDigest: z.string().regex(PLUGIN_CONTENT_HASH_PATTERN).optional(),
  currentContentHash: z.string().regex(PLUGIN_CONTENT_HASH_PATTERN)
})

export type PluginReviewedMarketplaceUpdate = z.infer<typeof pluginReviewedMarketplaceUpdateSchema>

export type PluginReviewedUpdatePublication = {
  consentFingerprint: string
  contentHash: string
  currentContentHash: string
  commitApproval: () => void
  restoreApproval: () => void
}
