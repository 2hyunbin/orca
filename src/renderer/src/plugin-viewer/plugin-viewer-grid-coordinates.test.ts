import { describe, expect, it } from 'vitest'
import {
  viewerColumnName,
  viewerGridNavigation,
  viewerGridScroll,
  VIEWER_ROW_HEIGHT,
  VIEWER_COLUMN_WIDTH,
  VIEWER_ROW_HEADER_WIDTH
} from './plugin-viewer-grid-coordinates'

const pane = { top: 20 * 28, left: 10 * 160, height: 12 * 28, width: 6 * 160 }

describe('virtual table keyboard navigation', () => {
  it('keeps document-edge navigation within the sheet and reveals the selected cell', () => {
    const end = viewerGridNavigation({ row: 20, column: 10 }, 'End', true, 1_000_000, 16_384, 10)
    expect(end).toEqual({ row: 999_999, column: 16_383 })
    expect(viewerGridScroll(end!, pane)).toMatchObject({
      top: 27_999_692,
      left: 2_620_528
    })
    const home = viewerGridNavigation(end!, 'Home', true, 1_000_000, 16_384, 10)
    expect(home).toEqual({ row: 0, column: 0 })
    expect(viewerGridScroll(home!, pane)).toMatchObject({ top: 0, left: 0 })
    expect(viewerColumnName(16_383)).toBe('XFD')
  })
  it('reveals a first cell covered by sticky headers after fractional scrolling', () => {
    expect(
      viewerGridScroll(
        { row: 20, column: 10 },
        { ...pane, top: pane.top + 10, left: pane.left + 39 }
      )
    ).toEqual({ top: pane.top, left: pane.left })
  })
  it('pages and crosses virtual boundaries without jumping over the selected cell', () => {
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End'
    ]) {
      for (const row of [0, 19, 20, 29, 30, 199]) {
        for (const column of [0, 9, 10, 14, 15, 23]) {
          const target = viewerGridNavigation({ row, column }, key, false, 200, 24, 10)!
          const next = viewerGridScroll(target, pane)
          expect(target.row * VIEWER_ROW_HEIGHT + VIEWER_ROW_HEIGHT).toBeGreaterThanOrEqual(
            next.top + VIEWER_ROW_HEIGHT
          )
          expect((target.row + 2) * VIEWER_ROW_HEIGHT).toBeLessThanOrEqual(next.top + pane.height)
          expect(
            target.column * VIEWER_COLUMN_WIDTH + VIEWER_ROW_HEADER_WIDTH
          ).toBeGreaterThanOrEqual(next.left + VIEWER_ROW_HEADER_WIDTH)
          expect(
            (target.column + 1) * VIEWER_COLUMN_WIDTH + VIEWER_ROW_HEADER_WIDTH
          ).toBeLessThanOrEqual(next.left + pane.width)
          expect(target.row).toBeLessThan(200)
          expect(target.column).toBeLessThan(24)
        }
      }
    }
    expect(viewerGridNavigation({ row: 0, column: 0 }, 'Tab', false, 200, 24, 10)).toBeNull()
  })
})
