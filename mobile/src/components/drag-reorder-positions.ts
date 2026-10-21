// Index math for DragReorderList. Kept worklet-safe (no captures, plain
// objects) because moveDragReorderKey runs on the UI thread during a drag.

export type DragReorderPositions = Record<string, number>

export function dragReorderPositionsFromKeys(keys: string[]): DragReorderPositions {
  'worklet'
  const positions: DragReorderPositions = {}
  for (let i = 0; i < keys.length; i++) {
    positions[keys[i]!] = i
  }
  return positions
}

export function orderedKeysFromDragReorderPositions(positions: DragReorderPositions): string[] {
  'worklet'
  const keys = Object.keys(positions)
  keys.sort((a, b) => positions[a]! - positions[b]!)
  return keys
}

export function clampDragReorderIndex(index: number, count: number): number {
  'worklet'
  if (count <= 0) {
    return 0
  }
  return Math.min(Math.max(index, 0), count - 1)
}

export function moveDragReorderKey(
  positions: DragReorderPositions,
  key: string,
  toIndex: number
): DragReorderPositions {
  'worklet'
  const fromIndex = positions[key]
  if (fromIndex === undefined || fromIndex === toIndex) {
    return positions
  }
  const next: DragReorderPositions = {}
  for (const currentKey of Object.keys(positions)) {
    const position = positions[currentKey]!
    if (currentKey === key) {
      next[currentKey] = toIndex
    } else if (fromIndex < toIndex && position > fromIndex && position <= toIndex) {
      next[currentKey] = position - 1
    } else if (toIndex < fromIndex && position >= toIndex && position < fromIndex) {
      next[currentKey] = position + 1
    } else {
      next[currentKey] = position
    }
  }
  return next
}

export type DragReorderMove = { movedId: string } & ({ beforeId: string } | { afterId: string })

export function dragReorderMove(keys: string[], movedId: string): DragReorderMove | null {
  const at = keys.indexOf(movedId)
  if (at === -1) {
    return null
  }
  const beforeId = keys[at + 1]
  const afterId = keys[at - 1]
  return beforeId ? { movedId, beforeId } : afterId ? { movedId, afterId } : null
}

export function dragReorderTop(
  positions: DragReorderPositions,
  sizes: Record<string, number>,
  key: string
): number {
  'worklet'
  const index = positions[key] ?? 0
  let top = 0
  for (const other of Object.keys(positions)) {
    if ((positions[other] ?? 0) < index) {
      top += sizes[other] ?? 0
    }
  }
  return top
}

export function dragReorderTarget(
  positions: DragReorderPositions,
  sizes: Record<string, number>,
  key: string,
  top: number
): number {
  'worklet'
  const from = positions[key] ?? 0
  let target = from
  let offset = 0
  for (const other of orderedKeysFromDragReorderPositions(positions)) {
    const height = sizes[other] ?? 0
    const index = positions[other] ?? 0
    const midpoint = offset + height / 2
    if (index < from && top < midpoint) {
      target = Math.min(target, index)
    }
    if (index > from && top + (sizes[key] ?? 0) > midpoint) {
      target = index
    }
    offset += height
  }
  return target
}
