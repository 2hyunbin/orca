import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { ipynbCellKey, storedOutput, updateIpynbCodeCell } from './ipynb-cell-mutations'
import { getSession, runningCellKey } from './ipynb-kernel-store'
import { isRecord, type IpynbDocument } from './ipynb-parse'

export function runningNotebookKeys(fileId: string, filePath: string | undefined): string[] {
  const session = filePath === undefined ? null : getSession(filePath)
  const key = session ? runningCellKey(session) : null
  return key !== null && session?.runs[key]?.fileId === fileId ? [key] : []
}

const cellsByKey = (document: IpynbDocument | null): Map<string, unknown> =>
  new Map((document?.cells ?? []).map((cell, index) => [ipynbCellKey(cell, index), cell]))

function sourceKeptBaselineOutput(before: unknown, incoming: unknown): boolean {
  if (
    !isRecord(before) ||
    before.cell_type !== 'code' ||
    !Array.isArray(before.outputs) ||
    !isRecord(incoming) ||
    incoming.cell_type !== 'code' ||
    !Array.isArray(incoming.outputs) ||
    before.outputs.length !== incoming.outputs.length
  ) {
    return false
  }
  return (
    structuralValuesEqual(before.outputs, incoming.outputs) ||
    structuralValuesEqual(before.outputs.map(storedOutput), incoming.outputs)
  )
}

export function foreignOutputCarryKeys(
  base: IpynbDocument | null,
  current: IpynbDocument | null,
  candidate: IpynbDocument,
  running: string[]
): string[] {
  const baselineCells = cellsByKey(base)
  const candidateCells = cellsByKey(candidate)
  const changed = (current?.cells ?? []).flatMap((cell, index) => {
    const key = ipynbCellKey(cell, index)
    const before = baselineCells.get(key)
    return isRecord(cell) &&
      cell.cell_type === 'code' &&
      !(isRecord(before) && before.outputs === cell.outputs)
      ? [key]
      : []
  })
  return [...new Set([...changed, ...running])].filter((key) =>
    sourceKeptBaselineOutput(baselineCells.get(key), candidateCells.get(key))
  )
}

export function carryNotebookOutput(
  previous: IpynbDocument | null,
  candidate: IpynbDocument,
  keys: string[]
): IpynbDocument {
  let next = candidate
  const previousCells = cellsByKey(previous)
  for (const key of previous ? keys : []) {
    const cell = previousCells.get(key)
    if (isRecord(cell) && Array.isArray(cell.outputs)) {
      const outputs = cell.outputs.filter(isRecord)
      const executionCount = typeof cell.execution_count === 'number' ? cell.execution_count : null
      next = updateIpynbCodeCell(next, key, { outputs: () => outputs, executionCount })
    }
  }
  return next
}
