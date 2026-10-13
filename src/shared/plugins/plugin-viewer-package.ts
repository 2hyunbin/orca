import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-tab-key'
import { pluginViewerContributionSchema } from './plugin-viewer-contributions'

export function pluginViewerKey(pluginKey: string, viewerId: string): string {
  return `viewer:${pluginKey}/${viewerId}`
}

export const pluginViewerMetadataSchema = pluginViewerContributionSchema
  .omit({ entry: true })
  .extend({
    key: z.string().max(512),
    pluginKey: z.string().refine(isQualifiedPluginKey),
    pluginName: z.string().min(1).max(256),
    revision: z.string().min(1).max(128),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
  .refine((viewer) => viewer.key === pluginViewerKey(viewer.pluginKey, viewer.id), {
    message: 'viewer key must match its package owner'
  })

export type PluginViewerMetadata = z.infer<typeof pluginViewerMetadataSchema>
