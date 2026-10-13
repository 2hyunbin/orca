import { z } from 'zod'
import { fileViewerProtocolVersion } from './plugin-viewer-author-api'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'
import {
  PLUGIN_VIEWER_CHUNK_BYTES,
  pluginViewerDocumentInfoSchema,
  pluginViewerReadResponseSchema
} from './plugin-viewer-document'
import {
  PLUGIN_VIEWER_CANVAS_BYTES,
  PLUGIN_VIEWER_CONTROL_BYTES,
  PLUGIN_VIEWER_TABLE_BYTES,
  pluginViewerSurfaceSchema,
  pluginViewerViewSchema,
  pluginViewerViewportSchema
} from './plugin-viewer-surface'

export const PLUGIN_VIEWER_WORKER_VERSION = fileViewerProtocolVersion
export const PLUGIN_VIEWER_WORKER_PENDING_READS = 2
export const PLUGIN_VIEWER_WORKER_PARSE_MS = 10_000
export const PLUGIN_VIEWER_WORKER_VIEW_MS = 2_000
export const PLUGIN_VIEWER_WORKER_PULSE_MS = 250
export const PLUGIN_VIEWER_WORKER_LIVENESS_MS = 2_000
export const PLUGIN_VIEWER_WORKER_ATTEMPT_LIMIT = { maxMessages: 1024, perMs: 10_000 } as const
export const PLUGIN_VIEWER_WORKER_READ_RATE_LIMIT = { maxMessages: 512, perMs: 10_000 } as const
export const PLUGIN_VIEWER_WORKER_CONTROL_RATE_LIMIT = { maxMessages: 180, perMs: 10_000 } as const
export const PLUGIN_VIEWER_WORKER_ERRORS = [
  'unsupported_format',
  'limit_exceeded',
  'parse_failed'
] as const

export const pluginViewerWorkerBindingSchema = z.strictObject({
  version: z.literal(PLUGIN_VIEWER_WORKER_VERSION),
  sessionId: z.string().uuid(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})
export const pluginViewerWorkerDocumentSchema = pluginViewerDocumentInfoSchema.omit({
  documentHandle: true
})
const requestId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const binding = pluginViewerWorkerBindingSchema.shape
const pulse = z.string().regex(/^[0-9a-f]{32}$/)

export const pluginViewerWorkerRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...binding, type: z.literal('alive'), pulse }),
  z.strictObject({
    ...binding,
    type: z.literal('ready'),
    surface: pluginViewerSurfaceSchema
  }),
  z
    .strictObject({
      ...binding,
      type: z.literal('read'),
      requestId,
      position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      length: z.number().int().min(1).max(PLUGIN_VIEWER_CHUNK_BYTES)
    })
    .refine((request) => Number.isSafeInteger(request.position + request.length)),
  z.strictObject({
    ...binding,
    type: z.literal('view'),
    requestId,
    view: pluginViewerViewSchema
  }),
  z.strictObject({
    ...binding,
    type: z.literal('error'),
    requestId: requestId.optional(),
    code: z.enum(PLUGIN_VIEWER_WORKER_ERRORS)
  })
])

export const pluginViewerWorkerResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...binding, type: z.literal('pulse'), pulse }),
  z.strictObject({
    ...binding,
    type: z.literal('initialize'),
    document: pluginViewerWorkerDocumentSchema
  }),
  z.strictObject({
    ...binding,
    type: z.literal('viewport'),
    requestId,
    viewport: pluginViewerViewportSchema
  }),
  z.strictObject({
    ...binding,
    type: z.literal('read-result'),
    requestId,
    response: pluginViewerReadResponseSchema
  })
])

export type PluginViewerWorkerBinding = z.infer<typeof pluginViewerWorkerBindingSchema>
export type PluginViewerWorkerDocument = z.infer<typeof pluginViewerWorkerDocumentSchema>
export type PluginViewerWorkerRequest = z.infer<typeof pluginViewerWorkerRequestSchema>
export type PluginViewerWorkerResponse = z.infer<typeof pluginViewerWorkerResponseSchema>
export type PluginViewerWorkerErrorCode = (typeof PLUGIN_VIEWER_WORKER_ERRORS)[number]

export function parsePluginViewerWorkerRequest(value: unknown): PluginViewerWorkerRequest | null {
  if (
    structuredCloneMessageBytes(value, PLUGIN_VIEWER_CANVAS_BYTES + 4096) >
    PLUGIN_VIEWER_CANVAS_BYTES + 4096
  ) {
    return null
  }
  const parsed = pluginViewerWorkerRequestSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const { data } = parsed
  if (data.type === 'view' && data.view.kind === 'canvas') {
    return data
  }
  if (data.type === 'view' && data.view.kind === 'table') {
    return structuredCloneMessageBytes(value, PLUGIN_VIEWER_TABLE_BYTES) <=
      PLUGIN_VIEWER_TABLE_BYTES
      ? data
      : null
  }
  return structuredCloneMessageBytes(value, PLUGIN_VIEWER_CONTROL_BYTES) <=
    PLUGIN_VIEWER_CONTROL_BYTES
    ? data
    : null
}
