import { translate } from '@/i18n/i18n'
import { ipynbCellKey, updateIpynbCodeCell } from './ipynb-cell-mutations'
import { noticeOutput } from './ipynb-kernel-outputs'
import { isRecord, type IpynbDocument } from './ipynb-parse'

/** UTF-16 units of output a notebook records; past this its whole text no longer fits a save. */
export const MAX_RECORDED_OUTPUT_UNITS = 224 * 1024 * 1024

// Why weak keys: outputs and output arrays are replaced, never mutated, so a size never goes stale.
const sizes = new WeakMap<object, number>()
const limitNotices = new WeakSet<object>()

function outputSize(output: unknown): number {
  if (!isRecord(output)) {
    return 0
  }
  const cached = sizes.get(output)
  if (cached !== undefined) {
    return cached
  }
  const { text } = output
  const size =
    typeof text === 'string'
      ? text.length
      : Array.isArray(text)
        ? text.reduce((sum: number, line) => sum + String(line).length, 0)
        : JSON.stringify(output).length
  sizes.set(output, size)
  return size
}

function cellOutputSize(cell: unknown): number {
  if (!isRecord(cell) || !Array.isArray(cell.outputs)) {
    return 0
  }
  const cached = sizes.get(cell.outputs)
  if (cached !== undefined) {
    return cached
  }
  const size = cell.outputs.reduce((sum: number, output) => sum + outputSize(output), 0)
  sizes.set(cell.outputs, size)
  return size
}

/** The notebook's recorded output, from sizes cached per output, so asking costs one pass over cells. */
export function recordedOutputSize(document: IpynbDocument): number {
  return document.cells.reduce((sum: number, cell) => sum + cellOutputSize(cell), 0)
}

/**
 * `after` unless output for the cell `key` grew the notebook past the limit; then `before` with
 * a notice ending that cell's output, so every cell whose output is dropped says so.
 */
export function limitRecordedOutput(
  before: IpynbDocument,
  after: IpynbDocument,
  key: string
): IpynbDocument {
  const grown = recordedOutputSize(after)
  if (grown <= MAX_RECORDED_OUTPUT_UNITS || grown <= recordedOutputSize(before)) {
    return after
  }
  const cell = before.cells.find((candidate, index) => ipynbCellKey(candidate, index) === key)
  const last = isRecord(cell) && Array.isArray(cell.outputs) ? cell.outputs.at(-1) : undefined
  if (isRecord(last) && limitNotices.has(last)) {
    return before
  }
  const notice = noticeOutput(
    translate(
      'auto.components.editor.IpynbViewer.outputLimitReached',
      "This cell's output reached the size limit; later output was not kept."
    )
  )
  limitNotices.add(notice)
  return updateIpynbCodeCell(before, key, {
    outputs: (outputs) => [...outputs, notice]
  })
}
