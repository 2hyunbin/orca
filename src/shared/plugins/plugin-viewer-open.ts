import { z } from 'zod'
import { PLUGIN_VIEWER_DOCUMENT_ERRORS } from './plugin-viewer-document'
import { pluginViewerChromeSchema } from './plugin-viewer-frame-protocol'

export const pluginViewerOpenRequestSchema = z.strictObject({
  filePath: z.string().min(1).max(32_768),
  workspaceId: z.string().min(1).max(1024),
  tabId: z.string().min(1).max(8192),
  viewerKey: z.string().min(1).max(256),
  executionHostId: z.string().min(1).max(1024),
  expectedEnvironmentPairingRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  expectedEnvironmentRuntimeId: z.string().min(1).max(256).optional(),
  expectedSshConnectionGeneration: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  access: z.strictObject({ kind: z.literal('user-file') }).optional(),
  chrome: pluginViewerChromeSchema
})
export const pluginViewerGuestLeaseSchema = z.strictObject({
  id: z.string().uuid(),
  partition: z.string().min(1).max(256),
  url: z.string().regex(/^orca-plugin-viewer:\/\/[0-9a-f-]{36}\/$/)
})
export const pluginViewerOpenResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), lease: pluginViewerGuestLeaseSchema }),
  z.strictObject({ ok: z.literal(false), error: z.enum(PLUGIN_VIEWER_DOCUMENT_ERRORS) })
])
export type PluginViewerOpenRequest = z.infer<typeof pluginViewerOpenRequestSchema>
export type PluginViewerGuestLease = z.infer<typeof pluginViewerGuestLeaseSchema>
export type PluginViewerOpenResponse = z.infer<typeof pluginViewerOpenResponseSchema>
