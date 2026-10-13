import { z } from 'zod'
import {
  PLUGIN_VIEWER_DOCUMENT_ERRORS,
  pluginViewerDocumentInfoSchema
} from './plugin-viewer-document'
import { PLUGIN_VIEWER_ENTRY_BYTES } from './plugin-viewer-contributions'
import { pluginViewerMetadataSchema } from './plugin-viewer-package'

export const pluginViewerInitializeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: z.strictObject({
      viewer: pluginViewerMetadataSchema,
      document: pluginViewerDocumentInfoSchema,
      source: z.string().min(1).max(PLUGIN_VIEWER_ENTRY_BYTES)
    })
  }),
  z.strictObject({ ok: z.literal(false), error: z.enum(PLUGIN_VIEWER_DOCUMENT_ERRORS) })
])

export type PluginViewerInitializeResponse = z.infer<typeof pluginViewerInitializeResponseSchema>
