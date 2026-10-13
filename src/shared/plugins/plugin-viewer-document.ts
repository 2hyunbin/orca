import { z } from 'zod'

export const PLUGIN_VIEWER_CHUNK_BYTES = 192 * 1024
export const PLUGIN_VIEWER_BASE64_BYTES = 256 * 1024
export const PLUGIN_VIEWER_DOCUMENT_BYTES = 50 * 1024 * 1024
export const PLUGIN_VIEWER_TRANSFER_BYTES = 100 * 1024 * 1024
export const PLUGIN_VIEWER_SESSION_LIMIT = 8
export const PLUGIN_VIEWER_OPENING_LIMIT = 2
export const PLUGIN_VIEWER_SESSION_READ_LIMIT = 2
export const PLUGIN_VIEWER_GLOBAL_READ_LIMIT = 4

export const PLUGIN_VIEWER_DOCUMENT_ERRORS = [
  'unavailable',
  'invalid_request',
  'unauthorized',
  'stale_revision',
  'unsupported_host',
  'limit_exceeded',
  'cancelled',
  'read_failed'
] as const

export type PluginViewerDocumentErrorCode = (typeof PLUGIN_VIEWER_DOCUMENT_ERRORS)[number]

export class PluginViewerDocumentError extends Error {
  constructor(readonly code: PluginViewerDocumentErrorCode) {
    super(code)
    this.name = 'PluginViewerDocumentError'
  }
}

export const pluginViewerDocumentInfoSchema = z.strictObject({
  documentHandle: z.string().uuid(),
  name: z.string().min(1).max(256),
  size: z.number().int().min(0).max(PLUGIN_VIEWER_DOCUMENT_BYTES),
  revision: z.string().uuid(),
  mimeHint: z.string().min(1).max(128).optional(),
  features: z.strictObject({ rangeRead: z.boolean(), watch: z.boolean() })
})

export const pluginViewerReadRequestSchema = z
  .strictObject({
    documentHandle: z.string().uuid(),
    revision: z.string().uuid(),
    position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    length: z.number().int().min(1).max(PLUGIN_VIEWER_CHUNK_BYTES)
  })
  .refine((request) => Number.isSafeInteger(request.position + request.length), {
    message: 'end offset must be a safe integer'
  })

export const pluginViewerReadResultSchema = z
  .strictObject({
    revision: z.string().uuid(),
    bytesRead: z.number().int().min(0).max(PLUGIN_VIEWER_CHUNK_BYTES),
    contentBase64: z
      .string()
      .max(PLUGIN_VIEWER_BASE64_BYTES)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    eof: z.boolean()
  })
  .superRefine((result, context) => {
    const padding = result.contentBase64.endsWith('==')
      ? 2
      : result.contentBase64.endsWith('=')
        ? 1
        : 0
    const decodedBytes = (result.contentBase64.length / 4) * 3 - padding
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const lastIndex = alphabet.indexOf(result.contentBase64.at(-1 - padding) ?? 'A')
    if (
      decodedBytes !== result.bytesRead ||
      (padding === 2 && lastIndex % 16 !== 0) ||
      (padding === 1 && lastIndex % 4 !== 0) ||
      (result.bytesRead === 0 && !result.eof)
    ) {
      context.addIssue({ code: 'custom', message: 'inconsistent or noncanonical byte payload' })
    }
  })

export const pluginViewerReadResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: pluginViewerReadResultSchema }),
  z.strictObject({ ok: z.literal(false), error: z.enum(PLUGIN_VIEWER_DOCUMENT_ERRORS) })
])

export type PluginViewerDocumentInfo = z.infer<typeof pluginViewerDocumentInfoSchema>
export type PluginViewerReadRequest = z.infer<typeof pluginViewerReadRequestSchema>
export type PluginViewerReadResult = z.infer<typeof pluginViewerReadResultSchema>
export type PluginViewerReadResponse = z.infer<typeof pluginViewerReadResponseSchema>
