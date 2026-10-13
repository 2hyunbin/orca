import type {
  PluginViewerAdapter,
  PluginViewerCell,
  PluginViewerWorkerSdk
} from '@orca/plugin-sdk/viewer'
import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'
import { readXlsxSharedStrings } from './xlsx-shared-strings'
import { readXlsxStyles } from './xlsx-styles'
import { readXlsxWorkbookGraph } from './xlsx-workbook-graph'
import { readXlsxWorksheet, type XlsxWorksheet } from './xlsx-worksheet'
import { XlsxZipArchive } from './xlsx-zip-archive'

export function createXlsxAdapter(
  sdk: Pick<PluginViewerWorkerSdk, 'readBytes'>
): PluginViewerAdapter {
  const sheets = new Map<string, XlsxWorksheet>()
  return {
    async open(document) {
      sheets.clear()
      const archive = await XlsxZipArchive.open(sdk, document.size)
      const graph = await readXlsxWorkbookGraph(archive)
      const strings = await readXlsxSharedStrings(archive, graph.strings)
      const styles = await readXlsxStyles(archive, graph.styles)
      for (const part of graph.sheets) {
        await archive.budget.checkpoint()
        const sheet = await readXlsxWorksheet(archive, part, strings, styles, graph.date1904)
        sheets.set(sheet.id, sheet)
      }
      return {
        kind: 'table',
        sheets: [...sheets.values()].map(({ id, label, rowCount, columnCount }) => ({
          id,
          label,
          rowCount,
          columnCount
        }))
      }
    },
    render(viewport) {
      if (viewport.kind !== 'table') {
        throw new XlsxFailure('unsupported_format')
      }
      const sheet = sheets.get(viewport.sheetId)
      if (
        !sheet ||
        !Number.isInteger(viewport.rowCount) ||
        !Number.isInteger(viewport.columnCount) ||
        viewport.rowCount < 1 ||
        viewport.rowCount > 64 ||
        viewport.columnCount < 1 ||
        viewport.columnCount > 64
      ) {
        throw new XlsxFailure('parse_failed')
      }
      const cells: PluginViewerCell[] = []
      for (
        let row = viewport.startRow;
        row < Math.min(viewport.startRow + viewport.rowCount, sheet.rowCount);
        row++
      ) {
        for (
          let column = viewport.startColumn;
          column < Math.min(viewport.startColumn + viewport.columnCount, sheet.columnCount);
          column++
        ) {
          const cell = sheet.cells.get(row * XLSX_LIMITS.columns + column)
          if (cell) {
            cells.push(cell)
          }
        }
      }
      return { kind: 'table', sheetId: sheet.id, cells }
    }
  }
}
