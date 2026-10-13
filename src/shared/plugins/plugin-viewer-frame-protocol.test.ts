import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parsePluginViewerFrameRequest,
  pluginViewerStatusSchema
} from './plugin-viewer-frame-protocol'
import { parsePluginViewerWorkerRequest } from './plugin-viewer-worker-protocol'

describe('viewer guest control boundary', () => {
  it('admits a selection-copy command without author text or arbitrary clipboard operations', () => {
    expect(parsePluginViewerFrameRequest({ type: 'copy-selection', id: 1 })).toEqual({
      type: 'copy-selection',
      id: 1
    })
    for (const value of [
      { type: 'copy-selection', id: 1, text: 'untrusted clipboard content' },
      { type: 'copy-selection', id: 1, channel: 'clipboard:readText' },
      { type: 'clipboard-read', id: 1 },
      { type: 'copy-selection', id: 0 }
    ]) {
      expect(parsePluginViewerFrameRequest(value)).toBeNull()
    }
    expect(
      parsePluginViewerWorkerRequest({
        type: 'copy-selection',
        requestId: 1,
        version: 1,
        sessionId: randomUUID(),
        generation: 0
      })
    ).toBeNull()
  })
  it('accepts only bounded host-owned viewport state', () => {
    const viewport = {
      kind: 'canvas',
      width: 512,
      height: 512,
      camera: { yaw: 45, pitch: 0, zoom: 2 }
    }
    expect(pluginViewerStatusSchema.parse({ type: 'ready', viewport })).toEqual({
      type: 'ready',
      viewport
    })
    expect(
      parsePluginViewerFrameRequest({
        type: 'status',
        status: { type: 'ready', viewport: { ...viewport, authorState: {} } }
      })
    ).toBeNull()
    expect(
      parsePluginViewerFrameRequest({
        type: 'status',
        status: { type: 'error', code: '/private/file' }
      })
    ).toBeNull()
  })
  it('refuses author HTML, arbitrary channels, pixel buffers and oversized attempted state', () => {
    for (const value of [
      { type: 'html', html: '<img src="https://example.invalid">' },
      { type: 'invoke', channel: 'filesystem:readFile' },
      {
        type: 'status',
        status: { type: 'ready', pixels: new Uint8ClampedArray(16 * 1024 * 1024) }
      },
      { type: 'frame-ready', extra: 'x'.repeat(17 * 1024) }
    ]) {
      expect(parsePluginViewerFrameRequest(value)).toBeNull()
    }
  })
  it('validates reads before crossing the isolated frame', () => {
    const request = { documentHandle: randomUUID(), revision: randomUUID(), position: 0, length: 1 }
    expect(parsePluginViewerFrameRequest({ type: 'read', id: 1, request })?.type).toBe('read')
    expect(
      parsePluginViewerFrameRequest({
        type: 'read',
        id: 1,
        request: { ...request, length: 1024 * 1024 }
      })
    ).toBeNull()
    expect(
      parsePluginViewerFrameRequest({
        type: 'read',
        id: 1,
        request: { ...request, filePath: '/tmp/private' }
      })
    ).toBeNull()
  })
})
