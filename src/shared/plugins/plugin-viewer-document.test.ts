import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_VIEWER_BASE64_BYTES,
  PLUGIN_VIEWER_CHUNK_BYTES,
  PLUGIN_VIEWER_DOCUMENT_BYTES,
  pluginViewerDocumentInfoSchema,
  pluginViewerReadRequestSchema,
  pluginViewerReadResponseSchema,
  pluginViewerReadResultSchema
} from './plugin-viewer-document'

const identity = { documentHandle: randomUUID(), revision: randomUUID() }
const request = { ...identity, position: 0, length: 1 }

describe('viewer byte protocol', () => {
  it('has separate decoded and encoded bounds for the bulk lane', () => {
    const payload = Buffer.alloc(PLUGIN_VIEWER_CHUNK_BYTES, 0x9a).toString('base64')
    expect(payload.length).toBe(PLUGIN_VIEWER_BASE64_BYTES)
    expect(
      pluginViewerReadResultSchema.safeParse({
        revision: identity.revision,
        bytesRead: PLUGIN_VIEWER_CHUNK_BYTES,
        contentBase64: payload,
        eof: false
      }).success
    ).toBe(true)
    expect(
      pluginViewerReadResultSchema.safeParse({
        revision: identity.revision,
        bytesRead: PLUGIN_VIEWER_CHUNK_BYTES + 1,
        contentBase64: `${payload}AA==`,
        eof: false
      }).success
    ).toBe(false)
  })

  it.each([
    { position: -1 },
    { position: 0.5 },
    { position: Number.NaN },
    { position: Infinity },
    { position: Number.MAX_SAFE_INTEGER },
    { length: 0 },
    { length: PLUGIN_VIEWER_CHUNK_BYTES + 1 },
    { revision: '../file' },
    { path: '/unopened/file' },
    { owner: 'another-client' }
  ])('rejects malformed offsets and client-supplied authority: %j', (change) => {
    expect(pluginViewerReadRequestSchema.safeParse({ ...request, ...change }).success).toBe(false)
  })

  it.each([
    ['AA==', 1, true],
    ['AAA=', 2, true],
    ['AAAA', 3, true],
    ['AB==', 1, false],
    ['AAB=', 2, false],
    ['AA', 1, false],
    ['AA==\n', 1, false],
    ['AAAA', 2, false],
    ['AAAA', 4, false],
    ['', 1, false]
  ])('validates canonical base64 and its byte count: %s', (contentBase64, bytesRead, valid) => {
    expect(
      pluginViewerReadResultSchema.safeParse({
        revision: identity.revision,
        bytesRead,
        contentBase64,
        eof: false
      }).success
    ).toBe(valid)
  })

  it('validates EOF, path-free document metadata and closed error codes', () => {
    expect(
      pluginViewerReadResultSchema.safeParse({
        revision: identity.revision,
        bytesRead: 0,
        contentBase64: '',
        eof: true
      }).success
    ).toBe(true)
    const info = {
      ...identity,
      name: 'model.stl',
      size: PLUGIN_VIEWER_DOCUMENT_BYTES,
      features: { rangeRead: true, watch: false }
    }
    expect(pluginViewerDocumentInfoSchema.safeParse(info).success).toBe(true)
    expect(pluginViewerDocumentInfoSchema.safeParse({ ...info, path: '/secret' }).success).toBe(
      false
    )
    expect(
      pluginViewerDocumentInfoSchema.safeParse({ ...info, size: PLUGIN_VIEWER_DOCUMENT_BYTES + 1 })
        .success
    ).toBe(false)
    expect(
      pluginViewerReadResponseSchema.safeParse({ ok: false, error: 'stale_revision' }).success
    ).toBe(true)
    expect(
      pluginViewerReadResponseSchema.safeParse({ ok: false, error: '/host/private-file' }).success
    ).toBe(false)
  })
})
