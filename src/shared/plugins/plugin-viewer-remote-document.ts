import { z } from 'zod'
import {
  PLUGIN_VIEWER_DOCUMENT_ERRORS,
  pluginViewerDocumentInfoSchema,
  pluginViewerReadRequestSchema
} from './plugin-viewer-document'
import { pluginViewerDocumentOwnerSchema } from './plugin-viewer-document-owner'

export const PLUGIN_VIEWER_REMOTE_DOCUMENT_VERSION = 1

export const pluginViewerRemoteLeaseSchema = z.strictObject({
  leaseId: z.string().uuid(),
  owner: pluginViewerDocumentOwnerSchema.extend({ clientId: z.string().min(1).max(128) })
})

export const pluginViewerRemoteOpenSchema = pluginViewerRemoteLeaseSchema.extend({
  file: z.strictObject({
    boundaryPath: z.string().min(1).max(32_768),
    entryPath: z.string().min(1).max(32_768)
  })
})

export const pluginViewerRemoteReadSchema = pluginViewerRemoteLeaseSchema.extend({
  request: pluginViewerReadRequestSchema
})

export const pluginViewerRemoteOpenResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    document: pluginViewerDocumentInfoSchema.extend({
      features: z.strictObject({ rangeRead: z.literal(true), watch: z.literal(false) })
    })
  }),
  z.strictObject({ ok: z.literal(false), error: z.enum(PLUGIN_VIEWER_DOCUMENT_ERRORS) })
])

export type PluginViewerRemoteLease = z.infer<typeof pluginViewerRemoteLeaseSchema>
export type PluginViewerRemoteOpenResponse = z.infer<typeof pluginViewerRemoteOpenResponseSchema>
