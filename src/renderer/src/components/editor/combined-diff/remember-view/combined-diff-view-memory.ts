import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { ORCA_AGENT_FILE_ACTIVITY_EVENT } from '@/hooks/agent-file-activity-event'

export type CachedCombinedDiffViewState = {
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
  /** The worktree's agent-activity count when remembered; a different count on restore means
   *  an agent may have changed files while this view was unmounted. */
  agentActivitySeq?: number
}

export const combinedDiffViewStateCache = new Map<string, CachedCombinedDiffViewState>()
export const combinedDiffScrollTopCache = new Map<string, number>()
export const combinedDiffScrollAnchorCache = new Map<string, VirtualizedScrollAnchor>()

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

// Why module state: unmounted views have no listener, so activity is counted per worktree here.
const agentActivitySeqByWorktreeId = new Map<string, number>()

export function getCombinedDiffAgentActivitySeq(worktreeId: string): number {
  return agentActivitySeqByWorktreeId.get(worktreeId) ?? 0
}

function handleCombinedDiffAgentActivity(
  event: WindowEventMap[typeof ORCA_AGENT_FILE_ACTIVITY_EVENT]
): void {
  const worktreeId = event.detail?.worktreeId
  if (worktreeId) {
    agentActivitySeqByWorktreeId.set(worktreeId, getCombinedDiffAgentActivitySeq(worktreeId) + 1)
  }
}

function handleCombinedDiffExternalFileChange(event: Event): void {
  const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
  if (detail?.relativePath && !detail.fileIds) {
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
    window.removeEventListener(ORCA_AGENT_FILE_ACTIVITY_EVENT, handleCombinedDiffAgentActivity)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
    handleCombinedDiffExternalFileChange
  )
  window.addEventListener(ORCA_AGENT_FILE_ACTIVITY_EVENT, handleCombinedDiffAgentActivity)
}

if (import.meta !== undefined && import.meta.hot) {
  // Vite can replace this module without a full renderer reload. Remove the
  // global cache-bust listener so dev sessions do not accumulate handlers.
  import.meta.hot.dispose(disposeCombinedDiffViewMemory)
}
