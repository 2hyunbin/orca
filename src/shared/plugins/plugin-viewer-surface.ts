import { z } from 'zod'
import type {
  PluginViewerSurface,
  PluginViewerView,
  PluginViewerViewport
} from './plugin-viewer-author-api'

export const PLUGIN_VIEWER_CONTROL_BYTES = 64 * 1024
export const PLUGIN_VIEWER_TABLE_BYTES = 4 * 1024 * 1024
export const PLUGIN_VIEWER_SHEET_LIMIT = 100
export const PLUGIN_VIEWER_ROW_LIMIT = 1_000_000
export const PLUGIN_VIEWER_COLUMN_LIMIT = 16_384
export const PLUGIN_VIEWER_VIEWPORT_ROWS = 64
export const PLUGIN_VIEWER_VIEWPORT_COLUMNS = 64
export const PLUGIN_VIEWER_CANVAS_DIMENSION = 2048
export const PLUGIN_VIEWER_CANVAS_BYTES = 16 * 1024 * 1024

const line = z.string().max(8192)
const sheetId = z.string().min(1).max(128)
const index = z.number().int().nonnegative()
const dimension = z.number().int().min(1).max(PLUGIN_VIEWER_CANVAS_DIMENSION)
const sheetSchema = z.strictObject({
  id: sheetId,
  label: z.string().min(1).max(256),
  rowCount: index.max(PLUGIN_VIEWER_ROW_LIMIT),
  columnCount: index.max(PLUGIN_VIEWER_COLUMN_LIMIT)
})

export const pluginViewerSurfaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), lineCount: index.max(PLUGIN_VIEWER_ROW_LIMIT) }),
  z.strictObject({
    kind: z.literal('table'),
    sheets: z
      .array(sheetSchema)
      .min(1)
      .max(PLUGIN_VIEWER_SHEET_LIMIT)
      .superRefine((sheets, ctx) => {
        if (new Set(sheets.map((sheet) => sheet.id)).size !== sheets.length) {
          ctx.addIssue({ code: 'custom', message: 'duplicate sheet identity' })
        }
      })
  }),
  z.strictObject({ kind: z.literal('canvas'), width: dimension, height: dimension })
]) satisfies z.ZodType<PluginViewerSurface>

export const pluginViewerViewportSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    startLine: index.max(PLUGIN_VIEWER_ROW_LIMIT - 1),
    lineCount: z.number().int().min(1).max(PLUGIN_VIEWER_VIEWPORT_ROWS)
  }),
  z.strictObject({
    kind: z.literal('table'),
    sheetId,
    startRow: index.max(PLUGIN_VIEWER_ROW_LIMIT - 1),
    startColumn: index.max(PLUGIN_VIEWER_COLUMN_LIMIT - 1),
    rowCount: z.number().int().min(1).max(PLUGIN_VIEWER_VIEWPORT_ROWS),
    columnCount: z.number().int().min(1).max(PLUGIN_VIEWER_VIEWPORT_COLUMNS)
  }),
  z.strictObject({
    kind: z.literal('canvas'),
    width: dimension,
    height: dimension,
    camera: z.strictObject({
      yaw: z.number().min(-360).max(360),
      pitch: z.number().min(-90).max(90),
      zoom: z.number().min(0.05).max(20)
    })
  })
]) satisfies z.ZodType<PluginViewerViewport>

const cellSchema = z.strictObject({
  row: index.max(PLUGIN_VIEWER_ROW_LIMIT - 1),
  column: index.max(PLUGIN_VIEWER_COLUMN_LIMIT - 1),
  text: line,
  kind: z.enum(['value', 'cached-formula'])
})

export const pluginViewerViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    startLine: index.max(PLUGIN_VIEWER_ROW_LIMIT - 1),
    lines: z.array(line).max(PLUGIN_VIEWER_VIEWPORT_ROWS)
  }),
  z.strictObject({
    kind: z.literal('table'),
    sheetId,
    cells: z
      .array(cellSchema)
      .max(PLUGIN_VIEWER_VIEWPORT_ROWS * PLUGIN_VIEWER_VIEWPORT_COLUMNS)
      .superRefine((cells, ctx) => {
        if (new Set(cells.map((cell) => `${cell.row}:${cell.column}`)).size !== cells.length) {
          ctx.addIssue({ code: 'custom', message: 'duplicate cell coordinate' })
        }
      })
  }),
  z
    .strictObject({
      kind: z.literal('canvas'),
      width: dimension,
      height: dimension,
      pixels: z.custom<Uint8ClampedArray>(
        (value) =>
          value instanceof Uint8ClampedArray &&
          value.buffer instanceof ArrayBuffer &&
          value.byteOffset === 0 &&
          value.byteLength === value.buffer.byteLength &&
          value.byteLength <= PLUGIN_VIEWER_CANVAS_BYTES
      )
    })
    .superRefine((view, ctx) => {
      if (view.pixels.byteLength !== view.width * view.height * 4) {
        ctx.addIssue({ code: 'custom', message: 'canvas dimensions do not match RGBA bytes' })
      }
    })
]) satisfies z.ZodType<PluginViewerView>

export type {
  PluginViewerSurface,
  PluginViewerView,
  PluginViewerViewport
} from './plugin-viewer-author-api'

export function isPluginViewerViewportAvailable(
  surface: PluginViewerSurface,
  viewport: PluginViewerViewport
): boolean {
  if (surface.kind === 'text' && viewport.kind === 'text') {
    return (
      viewport.startLine < surface.lineCount ||
      (surface.lineCount === 0 && viewport.startLine === 0)
    )
  }
  if (surface.kind === 'canvas' && viewport.kind === 'canvas') {
    return true
  }
  if (surface.kind !== 'table' || viewport.kind !== 'table') {
    return false
  }
  const sheet = surface.sheets.find((entry) => entry.id === viewport.sheetId)
  return Boolean(
    sheet &&
    (viewport.startRow < sheet.rowCount || (sheet.rowCount === 0 && viewport.startRow === 0)) &&
    (viewport.startColumn < sheet.columnCount ||
      (sheet.columnCount === 0 && viewport.startColumn === 0))
  )
}

export function isPluginViewerViewForViewport(
  surface: PluginViewerSurface,
  viewport: PluginViewerViewport,
  view: PluginViewerView
): boolean {
  if (!isPluginViewerViewportAvailable(surface, viewport)) {
    return false
  }
  if (surface.kind === 'text' && viewport.kind === 'text' && view.kind === 'text') {
    return (
      view.startLine === viewport.startLine &&
      view.lines.length <= Math.min(viewport.lineCount, surface.lineCount - viewport.startLine)
    )
  }
  if (viewport.kind === 'canvas' && view.kind === 'canvas') {
    return view.width === viewport.width && view.height === viewport.height
  }
  if (surface.kind !== 'table' || viewport.kind !== 'table' || view.kind !== 'table') {
    return false
  }
  const sheet = surface.sheets.find((entry) => entry.id === viewport.sheetId)
  return (
    view.sheetId === viewport.sheetId &&
    Boolean(
      sheet &&
      view.cells.every(
        (cell) =>
          cell.row >= viewport.startRow &&
          cell.row < Math.min(sheet.rowCount, viewport.startRow + viewport.rowCount) &&
          cell.column >= viewport.startColumn &&
          cell.column < Math.min(sheet.columnCount, viewport.startColumn + viewport.columnCount)
      )
    )
  )
}
