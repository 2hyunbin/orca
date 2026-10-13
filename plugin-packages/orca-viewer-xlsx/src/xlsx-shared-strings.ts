import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'
import { readXlsxXml, XLSX_MAIN_NAMESPACES } from './xlsx-xml'
import { isXlsxTag } from './xlsx-workbook-graph'
import type { XlsxZipArchive } from './xlsx-zip-archive'

export function decodeXlsxString(value: string): string {
  return value.replace(/_x([0-9a-fA-F]{4})_/g, (_, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16))
  )
}

export async function readXlsxSharedStrings(
  archive: XlsxZipArchive,
  part?: string
): Promise<string[]> {
  if (!part) {
    return []
  }
  const strings: string[] = []
  let chunks: string[] | undefined
  let length = 0
  await readXlsxXml(archive, part, 'sst', XLSX_MAIN_NAMESPACES, {
    start(tag, parents) {
      if (parents.length === 1 && isXlsxTag(tag, 'si')) {
        chunks = []
        length = 0
      }
    },
    text(value, parents) {
      const last = parents.at(-1)
      if (
        !chunks ||
        !last ||
        !isXlsxTag(last, 't') ||
        parents.some((tag) => isXlsxTag(tag, 'rPh'))
      ) {
        return
      }
      length += value.length
      if (length > XLSX_LIMITS.textLength) {
        throw new XlsxFailure('limit_exceeded')
      }
      chunks.push(value)
    },
    end(tag, parents) {
      if (parents.length === 1 && isXlsxTag(tag, 'si') && chunks) {
        strings.push(archive.budget.retain(decodeXlsxString(chunks.join(''))))
        chunks = undefined
        if (strings.length > XLSX_LIMITS.sharedStrings) {
          throw new XlsxFailure('limit_exceeded')
        }
      }
    }
  })
  return strings
}
