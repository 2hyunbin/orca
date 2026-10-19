import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'

export type CachedCombinedDiffViewState = {
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
}

export type CombinedDiffViewMemory = {
  worktreeId: string
  view?: CachedCombinedDiffViewState
  scrollTop?: number
  scrollAnchor?: NonNullable<VirtualizedScrollAnchor>
}

type CombinedDiffViewMemoryPatch = Partial<Omit<CombinedDiffViewMemory, 'worktreeId'>>

const memoryByViewKey = new Map<string, CombinedDiffViewMemory>()

export function readCombinedDiffViewMemory(viewKey: string): CombinedDiffViewMemory | undefined {
  return memoryByViewKey.get(viewKey)
}

/** A mounted viewer claims its key; only claimed keys accept writes. */
export function claimCombinedDiffViewMemory(viewKey: string, worktreeId: string): void {
  const memory = memoryByViewKey.get(viewKey)
  setWithLRU(memoryByViewKey, viewKey, memory?.worktreeId === worktreeId ? memory : { worktreeId })
}

// Why update-only: a viewer whose workspace was just forgotten unmounts afterwards and must not resurrect its entry.
export function updateCombinedDiffViewMemory(
  viewKey: string,
  patch: CombinedDiffViewMemoryPatch
): void {
  const memory = memoryByViewKey.get(viewKey)
  if (memory) {
    setWithLRU(memoryByViewKey, viewKey, { ...memory, ...patch })
  }
}

export function forgetCombinedDiffViewState(viewKey: string): void {
  updateCombinedDiffViewMemory(viewKey, { view: undefined })
}

export function forgetCombinedDiffViewStatesMatching(
  predicate: (view: CachedCombinedDiffViewState) => boolean
): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (memory.view && predicate(memory.view)) {
      memoryByViewKey.set(viewKey, { ...memory, view: undefined })
    }
  }
}

export function renameCombinedDiffViewOwner(oldWorktreeId: string, newWorktreeId: string): void {
  for (const [viewKey, memory] of memoryByViewKey) {
    if (memory.worktreeId === oldWorktreeId) {
      memoryByViewKey.set(viewKey, { ...memory, worktreeId: newWorktreeId })
    }
  }
}

/** A deleted workspace cannot restore its cached file bodies. Ordinary tab closes keep them. */
export function forgetCombinedDiffViewsForWorktrees(worktreeIds: Iterable<string>): void {
  const removed = new Set(worktreeIds)
  for (const [viewKey, memory] of memoryByViewKey) {
    if (removed.has(memory.worktreeId)) {
      memoryByViewKey.delete(viewKey)
    }
  }
}

export function clearCombinedDiffViewMemory(): void {
  memoryByViewKey.clear()
}
