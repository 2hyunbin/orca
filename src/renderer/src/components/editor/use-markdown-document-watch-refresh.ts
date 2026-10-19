import { useEffect } from 'react'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { hasMarkdownExtension } from './markdown-internal-links'

const DOCUMENT_WATCH_DEBOUNCE_MS = 125

function changesDocumentMembership(payload: FsChangedPayload, rootPath: string): boolean {
  if (
    normalizeRuntimePathForComparison(payload.worktreePath) !==
    normalizeRuntimePathForComparison(rootPath)
  ) {
    return false
  }

  return payload.events.some((event) => {
    if (event.kind === 'overflow') {
      return true
    }
    if (event.kind === 'update') {
      return false
    }
    return [event.absolutePath, event.oldAbsolutePath].some((path) => {
      if (!path) {
        return false
      }
      const relativePath = relativePathInsideRoot(rootPath, path)
      return (
        relativePath !== null && (event.isDirectory === true || hasMarkdownExtension(relativePath))
      )
    })
  })
}

export function useMarkdownDocumentWatchRefresh({
  enabled,
  worktreePath,
  runtimeEnvironmentId,
  refresh
}: {
  enabled: boolean
  worktreePath: string | null
  runtimeEnvironmentId: string | null | undefined
  refresh: (requireFresh: boolean, freshAfter: number) => Promise<void>
}): void {
  const owner = runtimeEnvironmentId?.trim() || null

  useEffect(() => {
    if (!enabled || !worktreePath) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestChangeAt = 0
    let scanInFlight = false
    let changedDuringScan = false
    let disposed = false
    const scheduleScan = (): void => {
      // Why: never push an armed scan back; watch batches arrive faster than the debounce under sustained writes.
      if (timer !== undefined) {
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        scanInFlight = true
        changedDuringScan = false
        // Each pane can join a scan begun after the latest change, while bypassing an older snapshot.
        void refresh(false, latestChangeAt).finally(() => {
          scanInFlight = false
          // Why: one scan at a time — overlapping scans supersede each other and publish nothing.
          if (changedDuringScan && !disposed) {
            scheduleScan()
          }
        })
      }, DOCUMENT_WATCH_DEBOUNCE_MS)
    }
    const handleChange = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      const { payload, runtimeEnvironmentId: eventOwner } = event.detail
      if (eventOwner !== owner || !changesDocumentMembership(payload, worktreePath)) {
        return
      }
      latestChangeAt = performance.now()
      if (scanInFlight) {
        changedDuringScan = true
        return
      }
      scheduleScan()
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    return () => {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleChange)
    }
  }, [enabled, owner, worktreePath, refresh])
}
