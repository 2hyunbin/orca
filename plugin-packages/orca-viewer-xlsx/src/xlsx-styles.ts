import { readXlsxXml, xlsxAttribute, XLSX_MAIN_NAMESPACES } from './xlsx-xml'
import { isXlsxTag } from './xlsx-workbook-graph'
import { XlsxFailure } from './xlsx-limits'
import type { XlsxZipArchive } from './xlsx-zip-archive'

export type XlsxNumberFormat = { id: number; code?: string }

export function xlsxUnsigned(value: string | undefined, maximum: number): number {
  if (value === undefined || !/^\d{1,10}$/.test(value)) {
    throw new XlsxFailure('parse_failed')
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new XlsxFailure('limit_exceeded')
  }
  return number
}

export async function readXlsxStyles(
  archive: XlsxZipArchive,
  part?: string
): Promise<XlsxNumberFormat[]> {
  if (!part) {
    return [{ id: 0 }]
  }
  const formats = new Map<number, string>()
  const cells: number[] = []
  await readXlsxXml(archive, part, 'styleSheet', XLSX_MAIN_NAMESPACES, {
    start(tag, parents) {
      if (parents.length !== 2) {
        return
      }
      if (isXlsxTag(parents[1], 'numFmts') && isXlsxTag(tag, 'numFmt')) {
        const id = xlsxUnsigned(xlsxAttribute(tag, 'numFmtId'), 65535)
        const code = xlsxAttribute(tag, 'formatCode')
        if (id < 164 || !code || formats.has(id)) {
          throw new XlsxFailure('parse_failed')
        }
        formats.set(id, archive.budget.retain(code))
      }
      if (isXlsxTag(parents[1], 'cellXfs') && isXlsxTag(tag, 'xf')) {
        cells.push(xlsxUnsigned(xlsxAttribute(tag, 'numFmtId') ?? '0', 65535))
      }
      if (formats.size > 65536 || cells.length > 65536) {
        throw new XlsxFailure('limit_exceeded')
      }
    }
  })
  return cells.length ? cells.map((id) => ({ id, code: formats.get(id) })) : [{ id: 0 }]
}
