import { z } from 'zod'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'
import {
  PLUGIN_VIEWER_DOCUMENT_ERRORS,
  pluginViewerReadRequestSchema,
  pluginViewerReadResponseSchema
} from './plugin-viewer-document'
import { pluginViewerInitializeResponseSchema } from './plugin-viewer-initialize'
import { pluginViewerViewportSchema } from './plugin-viewer-surface'
import {
  PLUGIN_VIEWER_WORKER_ERRORS,
  pluginViewerWorkerBindingSchema
} from './plugin-viewer-worker-protocol'

export const PLUGIN_VIEWER_STATE_BYTES = 16 * 1024
export const pluginViewerFailureSchema = z.enum([
  ...PLUGIN_VIEWER_DOCUMENT_ERRORS,
  ...PLUGIN_VIEWER_WORKER_ERRORS,
  'unresponsive',
  'invalid_output'
])
export const pluginViewerChromeSchema = z.strictObject({
  dark: z.boolean(),
  labels: z.strictObject({
    loading: z.string().min(1).max(256),
    empty: z.string().min(1).max(256),
    previous: z.string().min(1).max(128),
    next: z.string().min(1).max(128),
    sheet: z.string().min(1).max(128),
    reset: z.string().min(1).max(128),
    title: z.string().min(1).max(128),
    zoomIn: z.string().min(1).max(128),
    zoomOut: z.string().min(1).max(128),
    cachedFormula: z.string().min(1).max(256),
    failed: z.string().min(1).max(256),
    cellDetails: z.string().min(1).max(128).optional(),
    cellValue: z.string().min(1).max(128).optional(),
    copy: z.string().min(1).max(128).optional(),
    copied: z.string().min(1).max(128).optional(),
    copyFailed: z.string().min(1).max(256).optional(),
    close: z.string().min(1).max(128).optional()
  }),
  viewport: pluginViewerViewportSchema.optional()
})
export const pluginViewerStatusSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('loading') }),
  z.strictObject({ type: z.literal('ready'), viewport: pluginViewerViewportSchema }),
  z.strictObject({ type: z.literal('error'), code: pluginViewerFailureSchema })
])
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const pluginViewerFrameRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('frame-ready') }),
  z.strictObject({ type: z.literal('read'), id, request: pluginViewerReadRequestSchema }),
  z.strictObject({ type: z.literal('copy-selection'), id }),
  z.strictObject({ type: z.literal('status'), status: pluginViewerStatusSchema })
])
export const pluginViewerFrameResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('start'),
    chrome: pluginViewerChromeSchema,
    binding: pluginViewerWorkerBindingSchema,
    initialized: pluginViewerInitializeResponseSchema
  }),
  z.strictObject({ type: z.literal('read-result'), id, response: pluginViewerReadResponseSchema }),
  z.strictObject({ type: z.literal('copy-result'), id, ok: z.boolean() })
])
export type PluginViewerChrome = z.infer<typeof pluginViewerChromeSchema>
export type PluginViewerStatus = z.infer<typeof pluginViewerStatusSchema>
export type PluginViewerFrameRequest = z.infer<typeof pluginViewerFrameRequestSchema>
export type PluginViewerFrameResponse = z.infer<typeof pluginViewerFrameResponseSchema>

export function parsePluginViewerFrameRequest(value: unknown): PluginViewerFrameRequest | null {
  if (structuredCloneMessageBytes(value, PLUGIN_VIEWER_STATE_BYTES) > PLUGIN_VIEWER_STATE_BYTES) {
    return null
  }
  const parsed = pluginViewerFrameRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
