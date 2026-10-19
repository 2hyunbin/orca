import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'

export type CachedCombinedDiffViewState = {
  worktreeId: string
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
}

export const combinedDiffViewStateCache = new Map<string, CachedCombinedDiffViewState>()
export const combinedDiffScrollTopCache = new Map<string, number>()
export const combinedDiffScrollAnchorCache = new Map<string, VirtualizedScrollAnchor>()

export function renameCombinedDiffViewOwner(oldWorktreeId: string, newWorktreeId: string): void {
  for (const [key, view] of combinedDiffViewStateCache) {
    if (view.worktreeId === oldWorktreeId) {
      combinedDiffViewStateCache.set(key, { ...view, worktreeId: newWorktreeId })
    }
  }
}

/** A deleted workspace cannot restore its cached file bodies. Ordinary tab closes keep them. */
export function forgetCombinedDiffViewsForWorktrees(worktreeIds: Iterable<string>): void {
  const removed = new Set(worktreeIds)
  for (const [key, view] of combinedDiffViewStateCache) {
    if (removed.has(view.worktreeId)) {
      combinedDiffViewStateCache.delete(key)
      combinedDiffScrollTopCache.delete(key)
      combinedDiffScrollAnchorCache.delete(key)
    }
  }
}
