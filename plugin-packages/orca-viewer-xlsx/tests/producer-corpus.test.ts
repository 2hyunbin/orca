import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createXlsxAdapter } from '../src/xlsx-adapter'
import { fixtureDocument, fixtureSdk, workbookBytes } from './workbook-fixture'

async function producer(name: string) {
  const bytes = new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)))
  const adapter = createXlsxAdapter(fixtureSdk(bytes))
  const surface = await adapter.open(fixtureDocument(bytes))
  return { adapter, surface }
}

describe('independent workbook producer corpus', () => {
  it('opens real producer styles, Unicode, dates, hidden sheets and formulas without caches', async () => {
    const { adapter, surface } = await producer('ProducedBudget.xlsx')
    expect(surface).toEqual({
      kind: 'table',
      sheets: [
        { id: '1', label: 'Produced budget', rowCount: 4, columnCount: 4 },
        { id: '2', label: 'Hidden notes', rowCount: 1, columnCount: 1 }
      ]
    })
    const view = await adapter.render({
      kind: 'table',
      sheetId: '1',
      startRow: 1,
      startColumn: 0,
      rowCount: 3,
      columnCount: 4
    })
    if (view.kind !== 'table') {
      throw new Error('expected table')
    }
    expect(view.cells.map((cell) => cell.text)).toEqual([
      'Revenue – 世界',
      '12500.50',
      '2026-10-08',
      '12.50%',
      'Expenses',
      '8750.00',
      'TRUE',
      '<script>literal content</script>',
      'Net',
      'Cached value unavailable'
    ])
    expect(view.cells.at(-1)?.kind).toBe('cached-formula')
    expect(
      await adapter.render({
        kind: 'table',
        sheetId: '2',
        startRow: 0,
        startColumn: 0,
        rowCount: 1,
        columnCount: 1
      })
    ).toEqual({
      kind: 'table',
      sheetId: '2',
      cells: [
        { row: 0, column: 0, text: 'This hidden sheet is available in the picker', kind: 'value' }
      ]
    })
  })

  it('preserves the real 1904 epoch and useful custom time formats', async () => {
    const { adapter } = await producer('Produced1904.xlsx')
    const view = await adapter.render({
      kind: 'table',
      sheetId: '1',
      startRow: 0,
      startColumn: 0,
      rowCount: 1,
      columnCount: 3
    })
    if (view.kind !== 'table') {
      throw new Error('expected table')
    }
    expect(view.cells.map((cell) => cell.text)).toEqual(['1904-01-01', '1904-01-02', '12:00:00'])
  })

  it('opens the producer sparse boundary without a dense allocation', async () => {
    const { adapter, surface } = await producer('ProducedSparse.xlsx')
    expect(surface).toEqual({
      kind: 'table',
      sheets: [{ id: '1', label: 'Sparse limits', rowCount: 1_000_000, columnCount: 16384 }]
    })
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
      cells: [{ row: 999999, column: 16383, text: 'Sparse boundary value', kind: 'value' }]
    })
  })

  it('does not round a date-only value near midnight into the following day', async () => {
    const bytes = workbookBytes({
      styles: '<cellXfs><xf numFmtId="14"/></cellXfs>',
      cells: '<row><c><v>61.99999999</v></c></row>'
    })
    const adapter = createXlsxAdapter(fixtureSdk(bytes))
    await adapter.open(fixtureDocument(bytes))
    expect(
      await adapter.render({
        kind: 'table',
        sheetId: '1',
        startRow: 0,
        startColumn: 0,
        rowCount: 1,
        columnCount: 1
      })
    ).toEqual({
      kind: 'table',
      sheetId: '1',
      cells: [{ row: 0, column: 0, text: '1900-03-01', kind: 'value' }]
    })
  })
})
