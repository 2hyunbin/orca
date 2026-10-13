import { describe, expect, it } from 'vitest'
import {
  isPluginViewerViewForViewport,
  pluginViewerSurfaceSchema,
  pluginViewerViewSchema,
  pluginViewerViewportSchema,
  type PluginViewerSurface,
  type PluginViewerViewport
} from './plugin-viewer-surface'
import { parsePluginViewerWorkerRequest } from './plugin-viewer-worker-protocol'

const binding = { version: 1, sessionId: 'bfbfcd39-ed71-4a30-a22c-d74fa75d5887', generation: 2 }
const sheet = { id: 'sheet-1', label: 'Values', rowCount: 100, columnCount: 12 }
const surface: PluginViewerSurface = { kind: 'table', sheets: [sheet] }
const viewport: PluginViewerViewport = {
  kind: 'table',
  sheetId: sheet.id,
  startRow: 10,
  startColumn: 3,
  rowCount: 2,
  columnCount: 2
}
const cell = { row: 10, column: 3, text: '<img src="https://example.invalid">', kind: 'value' }

describe('host-owned viewer surface contracts', () => {
  it('accepts plain content while rejecting executable rendering instructions', () => {
    expect(
      pluginViewerViewSchema.safeParse({ kind: 'table', sheetId: sheet.id, cells: [cell] }).success
    ).toBe(true)
    for (const field of ['html', 'style', 'url', 'onClick', 'owner', 'filePath']) {
      expect(
        pluginViewerViewSchema.safeParse({
          kind: 'table',
          sheetId: sheet.id,
          cells: [{ ...cell, [field]: 'payload' }]
        }).success
      ).toBe(false)
    }
  })

  it('requires unique sheet identities and unique cell coordinates', () => {
    expect(
      pluginViewerSurfaceSchema.safeParse({ kind: 'table', sheets: [sheet, sheet] }).success
    ).toBe(false)
    expect(
      pluginViewerViewSchema.safeParse({ kind: 'table', sheetId: sheet.id, cells: [cell, cell] })
        .success
    ).toBe(false)
  })

  it.each([Infinity, Number.NaN, -1, 1_000_001])(
    'rejects invalid table dimensions: %s',
    (rowCount) => {
      expect(
        pluginViewerSurfaceSchema.safeParse({ kind: 'table', sheets: [{ ...sheet, rowCount }] })
          .success
      ).toBe(false)
    }
  )

  it('bounds sheet count, columns and requested viewport area', () => {
    expect(
      pluginViewerSurfaceSchema.safeParse({
        kind: 'table',
        sheets: Array.from({ length: 101 }, (_, id) => ({ ...sheet, id: String(id) }))
      }).success
    ).toBe(false)
    expect(
      pluginViewerSurfaceSchema.safeParse({
        kind: 'table',
        sheets: [{ ...sheet, columnCount: 16_385 }]
      }).success
    ).toBe(false)
    expect(pluginViewerViewportSchema.safeParse({ ...viewport, rowCount: 65 }).success).toBe(false)
    expect(pluginViewerViewportSchema.safeParse({ ...viewport, columnCount: 65 }).success).toBe(
      false
    )
  })

  it('allows sparse table values only in the requested sheet and rectangle', () => {
    const valid = pluginViewerViewSchema.parse({ kind: 'table', sheetId: sheet.id, cells: [cell] })
    expect(isPluginViewerViewForViewport(surface, viewport, valid)).toBe(true)
    for (const changed of [{ row: 9 }, { row: 12 }, { column: 2 }, { column: 5 }]) {
      const view = pluginViewerViewSchema.parse({
        kind: 'table',
        sheetId: sheet.id,
        cells: [{ ...cell, ...changed }]
      })
      expect(isPluginViewerViewForViewport(surface, viewport, view)).toBe(false)
    }
    expect(
      isPluginViewerViewForViewport(surface, viewport, {
        kind: 'table',
        sheetId: 'other',
        cells: []
      })
    ).toBe(false)
  })

  it('does not accept cells outside the declared document dimensions near the viewport edge', () => {
    const edge = { ...viewport, startRow: 99 }
    const view = pluginViewerViewSchema.parse({
      kind: 'table',
      sheetId: sheet.id,
      cells: [{ ...cell, row: 100 }]
    })
    expect(isPluginViewerViewForViewport(surface, edge, view)).toBe(false)
  })

  it('binds text results to the requested start and declared line count', () => {
    const text: PluginViewerSurface = { kind: 'text', lineCount: 3 }
    const request: PluginViewerViewport = { kind: 'text', startLine: 2, lineCount: 4 }
    expect(
      isPluginViewerViewForViewport(text, request, { kind: 'text', startLine: 2, lines: ['last'] })
    ).toBe(true)
    expect(
      isPluginViewerViewForViewport(text, request, { kind: 'text', startLine: 1, lines: ['wrong'] })
    ).toBe(false)
    expect(
      isPluginViewerViewForViewport(text, request, {
        kind: 'text',
        startLine: 2,
        lines: ['last', 'extra']
      })
    ).toBe(false)
    expect(
      isPluginViewerViewForViewport(
        { kind: 'text', lineCount: 0 },
        { kind: 'text', startLine: 0, lineCount: 1 },
        { kind: 'text', startLine: 0, lines: [] }
      )
    ).toBe(true)
  })

  it('accepts only exact, owned RGBA buffers for a bounded canvas', () => {
    const frame = { kind: 'canvas', width: 2, height: 2, pixels: new Uint8ClampedArray(16) }
    expect(pluginViewerViewSchema.safeParse(frame).success).toBe(true)
    for (const pixels of [
      new Uint8Array(16),
      new Uint8ClampedArray(12),
      'pixels',
      undefined,
      new Uint8ClampedArray(new ArrayBuffer(24), 0, 16),
      new Uint8ClampedArray(new ArrayBuffer(24), 8, 16)
    ]) {
      expect(pluginViewerViewSchema.safeParse({ ...frame, pixels }).success).toBe(false)
    }
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(
        pluginViewerViewSchema.safeParse({
          ...frame,
          pixels: new Uint8ClampedArray(new SharedArrayBuffer(16))
        }).success
      ).toBe(false)
    }
    expect(pluginViewerViewSchema.safeParse({ ...frame, width: 2049 }).success).toBe(false)
  })

  it('bounds numeric camera controls and matches canvas output to the requested size', () => {
    const request: PluginViewerViewport = {
      kind: 'canvas',
      width: 2,
      height: 2,
      camera: { yaw: 0, pitch: 0, zoom: 1 }
    }
    expect(
      pluginViewerViewportSchema.safeParse({
        ...request,
        camera: { ...request.camera, zoom: Infinity }
      }).success
    ).toBe(false)
    expect(
      isPluginViewerViewForViewport({ kind: 'canvas', width: 100, height: 100 }, request, {
        kind: 'canvas',
        width: 2,
        height: 2,
        pixels: new Uint8ClampedArray(16)
      })
    ).toBe(true)
    expect(
      isPluginViewerViewForViewport({ kind: 'canvas', width: 100, height: 100 }, request, {
        kind: 'canvas',
        width: 1,
        height: 2,
        pixels: new Uint8ClampedArray(8)
      })
    ).toBe(false)
  })

  it('admits a dense table through its bounded data lane', () => {
    const cells = Array.from({ length: 4096 }, (_, index) => ({
      ...cell,
      row: Math.floor(index / 64),
      column: index % 64,
      text: 'A useful ordinary spreadsheet value'
    }))
    expect(
      parsePluginViewerWorkerRequest({
        ...binding,
        type: 'view',
        requestId: 1,
        view: { kind: 'table', sheetId: sheet.id, cells }
      })
    ).not.toBeNull()
  })

  it('enforces the aggregate table budget even when each individual cell is valid', () => {
    const cells = Array.from({ length: 512 }, (_, index) => ({
      ...cell,
      row: Math.floor(index / 64),
      column: index % 64,
      text: '😀'.repeat(4096)
    }))
    expect(
      parsePluginViewerWorkerRequest({
        ...binding,
        type: 'view',
        requestId: 1,
        view: { kind: 'table', sheetId: sheet.id, cells }
      })
    ).toBeNull()
  })

  it('has a separate bounded canvas lane and rejects unknown authority fields', () => {
    const frame = {
      ...binding,
      type: 'view',
      requestId: 1,
      view: {
        kind: 'canvas',
        width: 256,
        height: 256,
        pixels: new Uint8ClampedArray(256 * 256 * 4)
      }
    }
    expect(parsePluginViewerWorkerRequest(frame)).not.toBeNull()
    expect(parsePluginViewerWorkerRequest({ ...frame, owner: 'forged' })).toBeNull()
    expect(
      parsePluginViewerWorkerRequest({
        ...frame,
        view: { ...frame.view, pixels: new Uint8ClampedArray(16 * 1024 * 1024 + 1) }
      })
    ).toBeNull()
    expect(
      parsePluginViewerWorkerRequest({
        ...binding,
        type: 'read',
        requestId: 1,
        position: Number.MAX_SAFE_INTEGER,
        length: 1
      })
    ).toBeNull()
  })
})
