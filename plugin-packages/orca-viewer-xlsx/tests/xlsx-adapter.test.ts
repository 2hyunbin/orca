import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { createXlsxAdapter } from '../src/xlsx-adapter'
import { XLSX_LIMITS } from '../src/xlsx-limits'
import { resolveXlsxPart } from '../src/xlsx-workbook-graph'
import {
  fixtureDocument,
  fixtureSdk,
  MAIN,
  REL,
  mutateZipPart,
  workbookBytes,
  workbookParts
} from './workbook-fixture'

async function open(bytes: Uint8Array) {
  const sdk = fixtureSdk(bytes)
  const adapter = createXlsxAdapter(sdk)
  const surface = await adapter.open(fixtureDocument(bytes))
  return { adapter, surface, sdk }
}

async function values(bytes: Uint8Array, sheetId = '1') {
  const { adapter } = await open(bytes)
  const view = await adapter.render({
    kind: 'table',
    sheetId,
    startRow: 0,
    startColumn: 0,
    rowCount: 64,
    columnCount: 64
  })
  if (view.kind !== 'table') {
    throw new Error('expected table')
  }
  return view.cells
}

describe('independently packaged XLSX adapter', () => {
  it.each([false, true])('opens a real ZIP/OOXML workbook (deflate=%s)', async (compressed) => {
    const bytes = workbookBytes({}, compressed)
    const { surface, sdk } = await open(bytes)
    expect(surface).toEqual({
      kind: 'table',
      sheets: [{ id: '1', label: 'Budget', rowCount: 1, columnCount: 1 }]
    })
    expect(await values(bytes)).toEqual([{ row: 0, column: 0, text: '42', kind: 'value' }])
    expect(sdk.reads.every((read) => read.length <= 192 * 1024)).toBe(true)
  })

  it('reads Unicode, rich text, booleans, errors and literal markup without following hyperlinks', async () => {
    const bytes = workbookBytes({
      strings:
        '<si><r><t>Olá </t></r><r><t>世界 &amp; &lt;script&gt;</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>',
      cells:
        '<row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>_x005F_x0041_ 😀</t></is></c><c t="b"><v>1</v></c><c t="e"><v>#DIV/0!</v></c></row>',
      parts: {
        'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link" Type="${REL}/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>`
      }
    })
    expect((await values(bytes)).map((cell) => cell.text)).toEqual([
      'Olá 世界 & <script>',
      '_x0041_ 😀',
      'TRUE',
      '#DIV/0!'
    ])
  })

  it('uses cached formula results and identifies missing caches without evaluating formulas', async () => {
    const bytes = workbookBytes({
      cells:
        '<row r="1"><c r="A1"><f>WEBSERVICE("https://example.invalid")</f><v>17</v></c><c r="B1"><f>1+2</f></c><c r="C1" t="str"><f>"hello"</f><v>hello</v></c></row>'
    })
    expect(await values(bytes)).toEqual([
      { row: 0, column: 0, text: '17', kind: 'cached-formula' },
      { row: 0, column: 1, text: 'Cached value unavailable', kind: 'cached-formula' },
      { row: 0, column: 2, text: 'hello', kind: 'cached-formula' }
    ])
  })

  it.each([false, true])(
    'keeps year-9999 dates within the selected epoch (1904=%s)',
    async (date1904) => {
      const lastDay = date1904 ? 2_957_003 : 2_958_465
      const bytes = workbookBytes({
        date1904,
        styles: '<cellXfs><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs>',
        cells: `<row><c><v>${lastDay}</v></c><c><v>${lastDay + 0.5}</v></c><c><v>${lastDay + 0.99999999}</v></c><c s="1"><v>${lastDay + 0.99999999}</v></c><c><v>${lastDay + 1}</v></c></row>`
      })
      expect((await values(bytes)).map((cell) => cell.text)).toEqual([
        '9999-12-31',
        '9999-12-31',
        '9999-12-31',
        '9999-12-31 23:59:59',
        String(lastDay + 1)
      ])
    }
  )

  it('formats dates, Excel’s leap-day placeholder, time, percentages and decimal numbers', async () => {
    const bytes = workbookBytes({
      styles:
        '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="20"/><xf numFmtId="10"/><xf numFmtId="2"/></cellXfs>',
      cells:
        '<row><c s="1"><v>1</v></c><c s="1"><v>60</v></c><c s="1"><v>61</v></c><c s="2"><v>61.5</v></c><c s="3"><v>0.5</v></c><c s="4"><v>0.125</v></c><c s="5"><v>12.3</v></c></row>'
    })
    expect((await values(bytes)).map((cell) => cell.text)).toEqual([
      '1900-01-01',
      '1900-02-29',
      '1900-03-01',
      '1900-03-01 12:00:00',
      '12:00:00',
      '12.50%',
      '12.30'
    ])
    expect(
      (
        await values(
          workbookBytes({
            date1904: true,
            styles: '<cellXfs><xf numFmtId="14"/></cellXfs>',
            cells: '<row><c><v>0</v></c></row>'
          })
        )
      )[0].text
    ).toBe('1904-01-01')
  })

  it('opens strict OOXML namespaces, UTF-16 parts and multiple sheets', async () => {
    const main = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
    const rel = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
    const xml = `<worksheet xmlns="${main}"><sheetData><row><c t="inlineStr"><is><t>שלום</t></is></c></row></sheetData></worksheet>`
    const utf16 = new Uint8Array(2 + xml.length * 2)
    utf16.set([0xff, 0xfe])
    const data = new DataView(utf16.buffer)
    for (let index = 0; index < xml.length; index++) {
      data.setUint16(2 + index * 2, xml.charCodeAt(index), true)
    }
    const bytes = workbookBytes({
      namespace: main,
      relationshipNamespace: rel,
      secondSheet: '<row><c t="inlineStr"><is><t>Second sheet</t></is></c></row>',
      parts: { 'xl/worksheets/sheet1.xml': utf16 }
    })
    expect((await open(bytes)).surface.kind).toBe('table')
    expect((await values(bytes))[0].text).toBe('שלום')
    expect((await values(bytes, '2'))[0].text).toBe('Second sheet')
  })

  it('keeps sparse large dimensions sparse and returns only the requested rectangle', async () => {
    const bytes = workbookBytes({
      dimension: 'A1:XFD1000000',
      cells: '<row r="1000000"><c r="XFD1000000"><v>99</v></c></row>'
    })
    const { adapter, surface } = await open(bytes)
    expect(surface).toEqual({
      kind: 'table',
      sheets: [{ id: '1', label: 'Budget', rowCount: 1_000_000, columnCount: 16384 }]
    })
    expect(
      await adapter.render({
        kind: 'table',
        sheetId: '1',
        startRow: 0,
        startColumn: 0,
        rowCount: 64,
        columnCount: 64
      })
    ).toEqual({ kind: 'table', sheetId: '1', cells: [] })
    expect(
      await adapter.render({
        kind: 'table',
        sheetId: '1',
        startRow: 999999,
        startColumn: 16383,
        rowCount: 1,
        columnCount: 1
      })
    ).toEqual({
      kind: 'table',
      sheetId: '1',
      cells: [{ row: 999999, column: 16383, text: '99', kind: 'value' }]
    })
  })

  it.each([
    { workbookType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' },
    {
      workbookExtra: '<externalReferences><externalReference r:id="external"/></externalReferences>'
    },
    {
      relationshipsExtra: `<Relationship Id="external" Type="${REL}/externalLink" Target="externalLinks/externalLink1.xml"/>`
    },
    {
      relationshipsExtra: `<Relationship Id="vba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>`
    }
  ])('refuses macro-enabled or externally linked workbooks: %j', async (options) => {
    await expect(open(workbookBytes(options))).rejects.toMatchObject({ code: 'unsupported_format' })
  })

  it.each([
    '../secret',
    '/../../secret',
    'https://example.invalid/file',
    '..%2fsecret',
    '%5csecret',
    'foo#fragment',
    'foo?query'
  ])('refuses unsafe OPC relationships: %s', (target) => {
    expect(() => resolveXlsxPart('', target)).toThrow()
  })

  it('resolves legitimate parent-relative OPC paths within the archive', () => {
    expect(resolveXlsxPart('xl/workbook.xml', '../sheets/main.xml')).toBe('sheets/main.xml')
    expect(resolveXlsxPart('xl/workbook.xml', '/xl/worksheets/sheet%201.xml')).toBe(
      'xl/worksheets/sheet 1.xml'
    )
  })

  it.each([
    '<row><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
    '<row><c t="s"><v>9</v></c></row>',
    '<row><c t="b"><v>true</v></c></row>',
    '<row><c><v>Infinity</v></c></row>',
    '<row><c><v>1e999</v></c></row>',
    '<row><c s="1"><v>5</v></c></row>',
    '<row><c><v>1</v><v>2</v></c></row>'
  ])('rejects ambiguous or invalid cell data: %s', async (cells) => {
    await expect(open(workbookBytes({ cells }))).rejects.toMatchObject({ code: 'parse_failed' })
  })

  it.each([
    '<!DOCTYPE worksheet [<!ENTITY leak SYSTEM "https://example.invalid/">]>',
    '<!DOCTYPE worksheet [<!ENTITY x "abc">]>'
  ])('refuses DTDs before consuming entities: %s', async (doctype) => {
    await expect(
      open(
        workbookBytes({
          parts: {
            'xl/worksheets/sheet1.xml': `${doctype}<worksheet xmlns="${MAIN}"><sheetData/></worksheet>`
          }
        })
      )
    ).rejects.toMatchObject({ code: 'unsupported_format' })
  })

  it.each([
    `<worksheet xmlns="${MAIN}"><sheetData><row><c t="inlineStr"><is><t>&notDefined;</t></is></c></row></sheetData></worksheet>`,
    `<worksheet xmlns="${MAIN}"><sheetData></worksheet>`,
    `<worksheet xmlns="${MAIN}"/><worksheet xmlns="${MAIN}"/>`
  ])('rejects malformed XML and unknown entities', async (xml) => {
    await expect(
      open(workbookBytes({ parts: { 'xl/worksheets/sheet1.xml': xml } }))
    ).rejects.toMatchObject({ code: 'parse_failed' })
  })

  it('refuses excessive nesting, oversized cells and unsupported dimensions', async () => {
    const nested = `<worksheet xmlns="${MAIN}">${'<x>'.repeat(70)}${'</x>'.repeat(70)}</worksheet>`
    await expect(
      open(workbookBytes({ parts: { 'xl/worksheets/sheet1.xml': nested } }))
    ).rejects.toMatchObject({ code: 'limit_exceeded' })
    await expect(
      open(
        workbookBytes({
          cells: `<row><c t="inlineStr"><is><t>${'x'.repeat(8193)}</t></is></c></row>`
        })
      )
    ).rejects.toMatchObject({ code: 'limit_exceeded' })
    await expect(open(workbookBytes({ dimension: 'A1:XFE1' }))).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    await expect(open(workbookBytes({ dimension: 'A1:A1000001' }))).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
  })

  it('verifies actual output size and CRC rather than trusting ZIP metadata', async () => {
    const bytes = workbookBytes({
      cells: `<row><c t="inlineStr"><is><t>${'x'.repeat(8000)}</t></is></c></row>`
    })
    const understated = mutateZipPart(bytes, 'xl/worksheets/sheet1.xml', (view, central, local) => {
      view.setUint32(central + 24, 1, true)
      view.setUint32(local + 22, 1, true)
    })
    await expect(open(understated)).rejects.toMatchObject({ code: 'parse_failed' })
    const wrongCrc = mutateZipPart(bytes, 'xl/worksheets/sheet1.xml', (view, central, local) => {
      view.setUint32(central + 16, 0, true)
      view.setUint32(local + 14, 0, true)
    })
    await expect(open(wrongCrc)).rejects.toMatchObject({ code: 'parse_failed' })
    const overLimit = mutateZipPart(bytes, 'xl/worksheets/sheet1.xml', (view, central) => {
      view.setUint32(central + 24, XLSX_LIMITS.partBytes + 1, true)
    })
    await expect(open(overLimit)).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  it('rejects traversal filenames, encrypted entries and mismatched local headers', async () => {
    const traversal = zipSync({ ...workbookParts(), '../escape': strToU8('bad') })
    await expect(open(traversal)).rejects.toMatchObject({ code: 'unsupported_format' })
    const encrypted = mutateZipPart(workbookBytes(), 'xl/workbook.xml', (view, central) => {
      view.setUint16(central + 8, 1, true)
    })
    await expect(open(encrypted)).rejects.toMatchObject({ code: 'unsupported_format' })
    const mismatch = mutateZipPart(workbookBytes(), 'xl/workbook.xml', (view, _central, local) => {
      view.setUint16(local + 8, 99, true)
    })
    await expect(open(mismatch)).rejects.toMatchObject({ code: 'parse_failed' })
  })

  it('fails closed on truncated input and short document reads', async () => {
    const bytes = workbookBytes()
    await expect(open(bytes.slice(0, -1))).rejects.toThrow()
    const adapter = createXlsxAdapter({ readBytes: async () => new Uint8Array(0) })
    await expect(adapter.open(fixtureDocument(bytes))).rejects.toMatchObject({
      code: 'parse_failed'
    })
  })
})
