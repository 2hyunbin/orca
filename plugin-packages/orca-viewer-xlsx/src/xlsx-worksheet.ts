import type { PluginViewerCell, PluginViewerSheet } from '@orca/plugin-sdk/viewer'
import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'
import { displayXlsxNumber } from './xlsx-number-display'
import { decodeXlsxString } from './xlsx-shared-strings'
import { xlsxUnsigned, type XlsxNumberFormat } from './xlsx-styles'
import { isXlsxTag, type XlsxSheetPart } from './xlsx-workbook-graph'
import { readXlsxXml, xlsxAttribute, XLSX_MAIN_NAMESPACES } from './xlsx-xml'
import type { XlsxZipArchive } from './xlsx-zip-archive'

export type XlsxWorksheet = PluginViewerSheet & { cells: Map<number, PluginViewerCell> }
type PendingCell = {
  row: number
  column: number
  type: string
  style: number
  formula: boolean
  valueSeen: boolean
  inlineSeen: boolean
  chunks: string[]
  length: number
}

export function xlsxCoordinate(reference: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference)
  if (!match) {
    throw new XlsxFailure('parse_failed')
  }
  let column = 0
  for (const letter of match[1]) {
    column = column * 26 + letter.charCodeAt(0) - 64
  }
  const row = Number(match[2])
  if (row > XLSX_LIMITS.rows || column > XLSX_LIMITS.columns) {
    throw new XlsxFailure('limit_exceeded')
  }
  return { row: row - 1, column: column - 1 }
}

function cellText(
  cell: PendingCell,
  raw: string,
  strings: string[],
  formats: XlsxNumberFormat[],
  date1904: boolean
): string {
  if (!cell.valueSeen && !cell.inlineSeen) {
    return cell.formula ? 'Cached value unavailable' : ''
  }
  if (cell.formula && raw === '' && cell.type !== 'str' && cell.type !== 'inlineStr') {
    return 'Cached value unavailable'
  }
  if (cell.type === 's') {
    const index = xlsxUnsigned(raw, XLSX_LIMITS.sharedStrings - 1)
    if (strings[index] === undefined) {
      throw new XlsxFailure('parse_failed')
    }
    return strings[index]
  }
  if (cell.type === 'inlineStr' || cell.type === 'str') {
    return decodeXlsxString(raw)
  }
  if (cell.type === 'b') {
    if (raw !== '0' && raw !== '1') {
      throw new XlsxFailure('parse_failed')
    }
    return raw === '1' ? 'TRUE' : 'FALSE'
  }
  if (cell.type === 'e') {
    return raw
  }
  if (cell.type === 'd') {
    if (
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw) ||
      !Number.isFinite(Date.parse(raw))
    ) {
      throw new XlsxFailure('parse_failed')
    }
    return raw
  }
  return raw ? displayXlsxNumber(raw, formats[cell.style], date1904) : ''
}

export async function readXlsxWorksheet(
  archive: XlsxZipArchive,
  part: XlsxSheetPart,
  strings: string[],
  formats: XlsxNumberFormat[],
  date1904: boolean
): Promise<XlsxWorksheet> {
  const cells = new Map<number, PluginViewerCell>()
  let rowCount = 0
  let columnCount = 0
  let row = -1
  let column = -1
  let pending: PendingCell | undefined
  await readXlsxXml(archive, part.part, 'worksheet', XLSX_MAIN_NAMESPACES, {
    start(tag, parents) {
      if (parents.length === 1 && isXlsxTag(tag, 'dimension')) {
        const reference = xlsxAttribute(tag, 'ref')
        const bounds = reference?.split(':')
        if (!bounds || bounds.length > 2) {
          throw new XlsxFailure('parse_failed')
        }
        const start = xlsxCoordinate(bounds[0])
        const end = xlsxCoordinate(bounds.at(-1) ?? '')
        if (end.row < start.row || end.column < start.column) {
          throw new XlsxFailure('parse_failed')
        }
        rowCount = Math.max(rowCount, end.row + 1)
        columnCount = Math.max(columnCount, end.column + 1)
      }
      if (parents.length === 2 && isXlsxTag(parents[1], 'sheetData') && isXlsxTag(tag, 'row')) {
        const declared = xlsxAttribute(tag, 'r')
        row = declared === undefined ? row + 1 : xlsxUnsigned(declared, XLSX_LIMITS.rows) - 1
        if (row < 0 || row >= XLSX_LIMITS.rows) {
          throw new XlsxFailure('limit_exceeded')
        }
        column = -1
        rowCount = Math.max(rowCount, row + 1)
      }
      if (parents.length === 3 && isXlsxTag(parents[2], 'row') && isXlsxTag(tag, 'c')) {
        const reference = xlsxAttribute(tag, 'r')
        const coordinate =
          reference === undefined ? { row, column: column + 1 } : xlsxCoordinate(reference)
        const type = xlsxAttribute(tag, 't') ?? 'n'
        const style = xlsxUnsigned(xlsxAttribute(tag, 's') ?? '0', 65535)
        if (
          coordinate.row !== row ||
          coordinate.column < 0 ||
          coordinate.column >= XLSX_LIMITS.columns ||
          !['n', 's', 'str', 'inlineStr', 'b', 'e', 'd'].includes(type) ||
          !formats[style] ||
          pending
        ) {
          throw new XlsxFailure('parse_failed')
        }
        if (++archive.budget.cells > XLSX_LIMITS.cells) {
          throw new XlsxFailure('limit_exceeded')
        }
        column = coordinate.column
        columnCount = Math.max(columnCount, column + 1)
        pending = {
          ...coordinate,
          type,
          style,
          formula: false,
          valueSeen: false,
          inlineSeen: false,
          chunks: [],
          length: 0
        }
      }
      if (pending && parents.length === 4) {
        if (isXlsxTag(tag, 'f')) {
          if (pending.formula) {
            throw new XlsxFailure('parse_failed')
          }
          pending.formula = true
        } else if (isXlsxTag(tag, 'v') || isXlsxTag(tag, 'is')) {
          if (
            pending.valueSeen ||
            pending.inlineSeen ||
            isXlsxTag(tag, 'is') !== (pending.type === 'inlineStr')
          ) {
            throw new XlsxFailure('parse_failed')
          }
          pending.valueSeen = isXlsxTag(tag, 'v')
          pending.inlineSeen = isXlsxTag(tag, 'is')
        }
      }
    },
    text(value, parents) {
      if (!pending || !parents.length) {
        return
      }
      const last = parents.at(-1)
      if (!last) {
        return
      }
      const cached = parents.length === 5 && isXlsxTag(last, 'v')
      const inline =
        pending.inlineSeen && isXlsxTag(last, 't') && !parents.some((tag) => isXlsxTag(tag, 'rPh'))
      if (cached || inline) {
        pending.length += value.length
        if (pending.length > XLSX_LIMITS.textLength) {
          throw new XlsxFailure('limit_exceeded')
        }
        pending.chunks.push(value)
      }
    },
    end(tag, parents) {
      if (!pending || parents.length !== 3 || !isXlsxTag(tag, 'c')) {
        return
      }
      const key = pending.row * XLSX_LIMITS.columns + pending.column
      if (cells.has(key)) {
        throw new XlsxFailure('parse_failed')
      }
      const text = cellText(pending, pending.chunks.join(''), strings, formats, date1904)
      cells.set(key, {
        row: pending.row,
        column: pending.column,
        text: pending.type === 's' ? text : archive.budget.retain(text),
        kind: pending.formula ? 'cached-formula' : 'value'
      })
      pending = undefined
    }
  })
  return { id: part.id, label: part.label, rowCount, columnCount, cells }
}
