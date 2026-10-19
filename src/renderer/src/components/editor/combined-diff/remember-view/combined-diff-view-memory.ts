import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'

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

// Why: session-scoped toolbar choices outlive the unmount, so they are module state rather than component state.
export const combinedDiffViewPreferences: {
  collapsed: boolean | null
  sideBySide: boolean | null
  fileTreeCollapsed: boolean | null
} = { collapsed: null, sideBySide: null, fileTreeCollapsed: null }

function invalidateCombinedDiffCachesForRelativePath(relativePath: string): void {
  for (const [key, cached] of combinedDiffViewStateCache.entries()) {
    if (cached.sections.some((section) => section.path === relativePath)) {
      combinedDiffViewStateCache.delete(key)
    }
  }
}

function handleCombinedDiffExternalFileChange(event: Event): void {
  const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
  if (detail?.relativePath) {
    // Why: inactive combined-diff tabs are unmounted, so only a module-level cache bust stops a remount replaying stale bodies.
    invalidateCombinedDiffCachesForRelativePath(detail.relativePath)
  }
}

export function disposeCombinedDiffViewMemory(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener(
      ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
      handleCombinedDiffExternalFileChange
    )
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
    handleCombinedDiffExternalFileChange
  )
}

if (import.meta !== undefined && import.meta.hot) {
  // Vite can replace this module without a full renderer reload. Remove the
  // global cache-bust listener so dev sessions do not accumulate handlers.
  import.meta.hot.dispose(disposeCombinedDiffViewMemory)
}
