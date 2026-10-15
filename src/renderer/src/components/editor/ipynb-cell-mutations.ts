import { createBrowserUuid } from '@/lib/browser-uuid'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { isRecord, type IpynbCellKind, type IpynbDocument } from './ipynb-parse'

function splitIpynbSource(source: string): string[] {
  if (!source) {
    return []
  }
  const lines: string[] = []
  let lineStart = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) {
      continue
    }
    lines.push(source.slice(lineStart, index + 1))
    lineStart = index + 1
  }
  if (lineStart < source.length) {
    lines.push(source.slice(lineStart))
  }
  return lines
}

/** The key a cell's run and editor use: its id, or its position for an id-less (nbformat 4.4) cell. */
export function ipynbCellKey(cell: unknown, index: number): string {
  if (isRecord(cell) && typeof cell.id === 'string') {
    return cell.id
  }
  return `${index}:${isRecord(cell) ? String(cell.cell_type) : ''}`
}

export function storedOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return output
  }
  const { transient: _transient, ...stored } = output
  // Like Jupyter, store stream text as lines so notebook diffs stay line-oriented.
  return stored.output_type === 'stream' && typeof stored.text === 'string'
    ? { ...stored, text: splitIpynbSource(stored.text) }
    : stored
}

function storedCell(cell: unknown): unknown {
  return isRecord(cell) && Array.isArray(cell.outputs) && cell.outputs.length > 0
    ? { ...cell, outputs: cell.outputs.map(storedOutput) }
    : cell
}

/** The notebook's file text; live-only fields (display ids) are dropped here, never in the model. */
export function serializeIpynbDocument(document: IpynbDocument): string {
  return `${JSON.stringify({ ...document.root, cells: document.cells.map(storedCell) }, null, 1)}\n`
}

function replaceCell(
  document: IpynbDocument,
  index: number,
  change: (cell: Record<string, unknown>) => Record<string, unknown>
): IpynbDocument {
  const cell = document.cells[index]
  if (!isRecord(cell)) {
    throw new Error('Notebook cell no longer exists')
  }
  const cells = [...document.cells]
  cells[index] = change(cell)
  return { ...document, cells }
}

export function updateIpynbCellSource(
  document: IpynbDocument,
  index: number,
  source: string
): IpynbDocument {
  return replaceCell(document, index, (cell) => ({
    ...cell,
    source: splitIpynbSource(source)
  }))
}

export function updateIpynbCellKind(
  document: IpynbDocument,
  index: number,
  kind: IpynbCellKind,
  fallbackLanguage: string
): IpynbDocument {
  return replaceCell(document, index, (cell) => {
    if (kind !== 'code') {
      const { outputs: _outputs, execution_count: _executionCount, ...rest } = cell
      return { ...rest, cell_type: kind }
    }
    const metadata = isRecord(cell.metadata) ? cell.metadata : {}
    const vscode = isRecord(metadata.vscode) ? metadata.vscode : {}
    return {
      ...cell,
      cell_type: kind,
      outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
      execution_count: typeof cell.execution_count === 'number' ? cell.execution_count : null,
      metadata: {
        ...metadata,
        vscode: { ...vscode, languageId: fallbackLanguage }
      }
    }
  })
}

function newCell(kind: IpynbCellKind, language: string): Record<string, unknown> {
  const cell: Record<string, unknown> = {
    cell_type: kind,
    id: createBrowserUuid(),
    metadata: {},
    source: []
  }
  return kind === 'code'
    ? {
        ...cell,
        execution_count: null,
        outputs: [],
        metadata: { vscode: { languageId: language } }
      }
    : cell
}

export function insertIpynbCell(
  document: IpynbDocument,
  index: number,
  kind: IpynbCellKind,
  language: string
): IpynbDocument {
  const cells = [...document.cells]
  cells.splice(Math.min(Math.max(index, 0), cells.length), 0, newCell(kind, language))
  return { ...document, cells }
}

export function deleteIpynbCell(document: IpynbDocument, index: number): IpynbDocument {
  if (document.cells.length <= 1) {
    const cell = { cell_type: 'code', id: createBrowserUuid(), metadata: {} }
    return {
      ...document,
      cells: [{ ...cell, execution_count: null, outputs: [], source: [] }]
    }
  }
  return {
    ...document,
    cells: document.cells.filter((_cell, cellIndex) => cellIndex !== index)
  }
}

export function moveIpynbCell(
  document: IpynbDocument,
  index: number,
  direction: -1 | 1
): IpynbDocument {
  const nextIndex = index + direction
  const { cells } = document
  if (index < 0 || index >= cells.length || nextIndex < 0 || nextIndex >= cells.length) {
    return document
  }
  const moved = [...cells]
  moved[index] = cells[nextIndex]
  moved[nextIndex] = cells[index]
  return { ...document, cells: moved }
}

/** Changes the code cell keyed `key`; returns `document` itself when there is no such code cell. */
export function updateIpynbCodeCell(
  document: IpynbDocument,
  key: string,
  change: {
    outputs?: (outputs: NotebookOutput[]) => NotebookOutput[]
    executionCount?: number | null
  }
): IpynbDocument {
  const index = document.cells.findIndex((cell, cellIndex) => ipynbCellKey(cell, cellIndex) === key)
  const cell = document.cells[index]
  if (!isRecord(cell) || cell.cell_type !== 'code') {
    return document
  }
  const outputs = Array.isArray(cell.outputs) ? cell.outputs.filter(isRecord) : []
  return replaceCell(document, index, () => ({
    ...cell,
    ...(change.outputs ? { outputs: change.outputs(outputs) } : {}),
    ...(change.executionCount === undefined ? {} : { execution_count: change.executionCount })
  }))
}

export function clearIpynbOutputs(document: IpynbDocument): IpynbDocument {
  return {
    ...document,
    cells: document.cells.map((cell) =>
      isRecord(cell) && cell.cell_type === 'code'
        ? { ...cell, outputs: [], execution_count: null }
        : cell
    )
  }
}

/** Gives every cell an nbformat 4.5 id, as Jupyter does when it upgrades a 4.4 notebook. */
export function withIpynbCellIds(document: IpynbDocument): IpynbDocument {
  const { root, cells } = document
  if (cells.every((cell) => !isRecord(cell) || typeof cell.id === 'string')) {
    return document
  }
  return {
    root: {
      ...root,
      nbformat_minor: Math.max(typeof root.nbformat_minor === 'number' ? root.nbformat_minor : 0, 5)
    },
    cells: cells.map((cell) =>
      isRecord(cell) && typeof cell.id !== 'string' ? { ...cell, id: createBrowserUuid() } : cell
    )
  }
}
