import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { shouldResetFileExplorerForVisibleWorktree } from './file-explorer-reset'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'
import type { DirCache } from './file-explorer-types'
import { splitPathSegments } from './path-tree'

type UseFileExplorerTreeLoadEffectsParams = {
  visibleFilesWorktreePath: string | null
  displayRootPath?: string | null
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootError: string | null
  isDirStale: (dirPath: string) => boolean
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<boolean>
  refreshTree: () => Promise<unknown>
  resetAndLoad: () => void
  resetSelection: () => void
  setNameFilterQuery: Dispatch<SetStateAction<string>>
}

/** Reset/retry/stale-dir loads for the currently visible worktree tree. */
export function useFileExplorerTreeLoadEffects({
  visibleFilesWorktreePath,
  displayRootPath = visibleFilesWorktreePath,
  expanded,
  dirCache,
  loadingDirPaths,
  rootError,
  isDirStale,
  loadDir,
  refreshTree,
  resetAndLoad,
  resetSelection,
  setNameFilterQuery
}: UseFileExplorerTreeLoadEffectsParams): void {
  const [completedStaleRefreshes, setCompletedStaleRefreshes] = useState(0)
  const staleRefreshRef = useRef<{
    worktreePath: string
    promise: Promise<unknown>
  } | null>(null)
  useEffect(() => {
    staleRefreshRef.current = null
    return () => {
      staleRefreshRef.current = null
    }
  }, [visibleFilesWorktreePath])
  const followSymlinks = useAppStore((s) => s.settings?.followSymlinkedDirectories ?? false)
  const lastFollowSymlinks = useRef(followSymlinks)
  useEffect(() => {
    if (lastFollowSymlinks.current !== followSymlinks) {
      lastFollowSymlinks.current = followSymlinks
      if (visibleFilesWorktreePath) {
        resetAndLoad()
      }
    }
  }, [followSymlinks, visibleFilesWorktreePath, resetAndLoad])
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)

  const lastResetWorktreePathRef = useRef<string | null>(null)
  const resetForVisibleWorktree = useEffectEvent(() => {
    setNameFilterQuery('')
    resetAndLoad()
    clearFileExplorerUndoHistory()
  })
  useEffect(
    () => () => {
      lastResetWorktreePathRef.current = null
    },
    []
  )
  useEffect(() => {
    if (!visibleFilesWorktreePath) {
      return
    }
    // Why: the sidebar remains mounted while closed to preserve caches, but
    // loading the hidden tree would probe every clicked workspace on macOS.
    if (
      !shouldResetFileExplorerForVisibleWorktree(
        lastResetWorktreePathRef.current,
        visibleFilesWorktreePath
      )
    ) {
      return
    }
    lastResetWorktreePathRef.current = visibleFilesWorktreePath
    resetSelection()
    resetForVisibleWorktree()
  }, [visibleFilesWorktreePath, resetSelection])

  // Why: on app startup the file explorer loads before SSH providers are
  // registered, so readDir fails for remote worktrees. When the SSH
  // connection is later established, sshConnectedGeneration bumps and this
  // effect retries the load. Only retries when there was a prior error to
  // avoid redundant reloads for local worktrees.
  const sshGenRef = useRef(sshConnectedGeneration)
  const retryFailedRootLoad = useEffectEvent(() => {
    if (rootError) {
      resetAndLoad()
    }
  })
  useEffect(() => {
    if (sshConnectedGeneration > sshGenRef.current) {
      sshGenRef.current = sshConnectedGeneration
      if (visibleFilesWorktreePath) {
        retryFailedRootLoad()
      }
    }
  }, [sshConnectedGeneration, visibleFilesWorktreePath])

  useEffect(() => {
    if (
      !visibleFilesWorktreePath ||
      !displayRootPath ||
      displayRootPath === visibleFilesWorktreePath ||
      dirCache[displayRootPath] ||
      loadingDirPaths.has(displayRootPath)
    ) {
      return
    }
    const depth =
      splitPathSegments(displayRootPath.slice(visibleFilesWorktreePath.length + 1)).length - 1
    void loadDir(displayRootPath, depth)
  }, [visibleFilesWorktreePath, displayRootPath, dirCache, loadingDirPaths, loadDir])

  // Why an event: only expansion and worktree changes load; dirCache/loading churn must not fan out reads.
  const loadExpandedDirs = useEffectEvent((worktreePath: string, expandedDirs: Set<string>) => {
    for (const dirPath of expandedDirs) {
      // Why first: a refresh wave marks every dir it owns before its first read lands, and without
      // this the effect would fan out an unbounded loadDir per dir on the next `expanded` change.
      if (loadingDirPaths.has(dirPath)) {
        continue
      }
      // Why: a full refresh (watcher overflow) re-reads only root and the dirs expanded at the time,
      // so a listing cached while collapsed is unverified — re-read it here instead of trusting it.
      if (dirCache[dirPath]?.error) {
        continue
      }
      const decision = decideExpandedDirLoad(dirCache[dirPath], isDirStale(dirPath))
      if (decision === 'skip') {
        continue
      }
      const depth = splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
      void loadDir(dirPath, depth, decision === 'reload' ? { force: true } : undefined)
    }
  })
  useEffect(() => {
    if (visibleFilesWorktreePath) {
      loadExpandedDirs(visibleFilesWorktreePath, expanded)
    }
  }, [expanded, visibleFilesWorktreePath])

  useEffect(() => {
    if (
      !visibleFilesWorktreePath ||
      rootError ||
      loadingDirPaths.size > 0 ||
      staleRefreshRef.current?.worktreePath === visibleFilesWorktreePath ||
      !Array.from(expanded).some(
        (dirPath) => dirCache[dirPath] && !dirCache[dirPath].error && isDirStale(dirPath)
      )
    ) {
      return
    }
    // Reopening during an older read must retry after it drains, using the bounded refresh wave.
    const refresh = { worktreePath: visibleFilesWorktreePath, promise: refreshTree() }
    staleRefreshRef.current = refresh
    const finish = () => {
      if (staleRefreshRef.current === refresh) {
        staleRefreshRef.current = null
        setCompletedStaleRefreshes((count) => count + 1)
      }
    }
    void refresh.promise.then(finish, finish)
  }, [
    visibleFilesWorktreePath,
    rootError,
    loadingDirPaths,
    completedStaleRefreshes,
    expanded,
    dirCache,
    isDirStale,
    refreshTree
  ])
}
