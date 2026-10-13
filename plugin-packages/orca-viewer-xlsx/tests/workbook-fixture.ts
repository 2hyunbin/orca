import { zipSync, strToU8 } from 'fflate'
import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'

export const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'

export type WorkbookFixtureOptions = {
  cells?: string
  dimension?: string
  date1904?: boolean
  namespace?: string
  relationshipNamespace?: string
  strings?: string
  styles?: string
  workbookExtra?: string
  relationshipsExtra?: string
  workbookType?: string
  secondSheet?: string
  parts?: Record<string, string | Uint8Array>
}

export function workbookParts(options: WorkbookFixtureOptions = {}): Record<string, Uint8Array> {
  const main = options.namespace ?? MAIN
  const rel = options.relationshipNamespace ?? REL
  const relationships = [
    `<Relationship Id="one" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>`,
    options.secondSheet !== undefined
      ? `<Relationship Id="two" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/>`
      : '',
    options.strings !== undefined
      ? `<Relationship Id="strings" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>`
      : '',
    options.styles !== undefined
      ? `<Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/>`
      : '',
    options.relationshipsExtra ?? ''
  ].join('')
  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${options.workbookType ?? WORKBOOK}"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${PACKAGE}"><Relationship Id="office" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PACKAGE}">${relationships}</Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${main}" xmlns:r="${rel}"><workbookPr date1904="${options.date1904 ? '1' : '0'}"/><sheets><sheet name="Budget" sheetId="1" r:id="one"/>${options.secondSheet !== undefined ? '<sheet name="Notes" sheetId="2" r:id="two"/>' : ''}</sheets>${options.workbookExtra ?? ''}</workbook>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${main}">${options.dimension ? `<dimension ref="${options.dimension}"/>` : ''}<sheetData>${options.cells ?? '<row r="1"><c r="A1"><v>42</v></c></row>'}</sheetData></worksheet>`
  }
  if (options.secondSheet !== undefined) {
    parts['xl/worksheets/sheet2.xml'] =
      `<worksheet xmlns="${main}"><sheetData>${options.secondSheet}</sheetData></worksheet>`
  }
  if (options.strings !== undefined) {
    parts['xl/sharedStrings.xml'] = `<sst xmlns="${main}">${options.strings}</sst>`
  }
  if (options.styles !== undefined) {
    parts['xl/styles.xml'] = `<styleSheet xmlns="${main}">${options.styles}</styleSheet>`
  }
  Object.assign(parts, options.parts)
  return Object.fromEntries(
    Object.entries(parts).map(([name, value]) => [
      name,
      typeof value === 'string' ? strToU8(value) : value
    ])
  )
}

export function workbookBytes(options: WorkbookFixtureOptions = {}, compressed = true): Uint8Array {
  return zipSync(workbookParts(options), { level: compressed ? 6 : 0 })
}

export function fixtureSdk(
  bytes: Uint8Array
): Pick<PluginViewerWorkerSdk, 'readBytes'> & { reads: { position: number; length: number }[] } {
  const reads: { position: number; length: number }[] = []
  return {
    reads,
    async readBytes(position, length) {
      reads.push({ position, length })
      if (length > 192 * 1024 || position < 0 || position + length > bytes.length) {
        throw new Error('invalid document read')
      }
      return bytes.slice(position, position + length)
    }
  }
}

export function fixtureDocument(bytes: Uint8Array) {
  return {
    name: 'Budget.xlsx',
    size: bytes.length,
    revision: 'fixture-revision',
    features: { rangeRead: true, watch: false }
  }
}

export function mutateZipPart(
  bytes: Uint8Array,
  name: string,
  mutate: (view: DataView, central: number, local: number) => void
): Uint8Array {
  const output = bytes.slice()
  const view = new DataView(output.buffer)
  const end = output.length - 22
  let offset = view.getUint32(end + 16, true)
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const size = view.getUint16(offset + 28, true)
    const part = new TextDecoder().decode(output.subarray(offset + 46, offset + 46 + size))
    if (part === name) {
      mutate(view, offset, view.getUint32(offset + 42, true))
      return output
    }
    offset += 46 + size + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  throw new Error('fixture ZIP part missing')
}
