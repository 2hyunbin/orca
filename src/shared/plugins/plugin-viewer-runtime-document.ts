import { z } from 'zod'
import { pluginViewerRemoteLeaseSchema } from './plugin-viewer-remote-document'
import {
  PLUGIN_VIEWER_DOCUMENT_ERRORS,
  pluginViewerReadRequestSchema
} from './plugin-viewer-document'

export {
  PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY,
  PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY
} from './plugin-viewer-runtime-capability'

export const pluginViewerRuntimeLeaseSchema = pluginViewerRemoteLeaseSchema.extend({
  runtimeId: z.string().min(1).max(256)
})

export const pluginViewerRuntimeSelectionSchema = pluginViewerRuntimeLeaseSchema.extend({
  filePath: z.string().min(1).max(32_768)
})

export const pluginViewerRuntimeOpenSchema = pluginViewerRuntimeSelectionSchema.extend({
  selectionGrantId: z.string().uuid().optional()
})

export const pluginViewerRuntimeSelectionResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), grantId: z.string().uuid() }),
  z.strictObject({ ok: z.literal(false), error: z.enum(PLUGIN_VIEWER_DOCUMENT_ERRORS) })
])

export const pluginViewerRuntimeReadSchema = pluginViewerRuntimeLeaseSchema.extend({
  request: pluginViewerReadRequestSchema
})

export const pluginViewerRuntimeObservationSchema = z
  .object({
    kind: z.literal('plugin-viewer-lifecycle'),
    leaseId: z.string().uuid(),
    runtimeId: z.string().min(1).max(256),
    closed: z.boolean()
  })
  .strict()

export type PluginViewerRuntimeLease = z.infer<typeof pluginViewerRuntimeLeaseSchema>
export type PluginViewerRuntimeOpen = z.infer<typeof pluginViewerRuntimeOpenSchema>
export type PluginViewerRuntimeSelection = z.infer<typeof pluginViewerRuntimeSelectionSchema>
export type PluginViewerRuntimeSelectionResponse = z.infer<
  typeof pluginViewerRuntimeSelectionResponseSchema
>
export type PluginViewerRuntimeRead = z.infer<typeof pluginViewerRuntimeReadSchema>
