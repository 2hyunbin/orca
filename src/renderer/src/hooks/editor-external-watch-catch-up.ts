import { useAppStore } from '@/store'
import {
  canAutoSaveOpenFile,
  isExternalReloadableEditorTab
} from '@/components/editor/editor-autosave'
import { isMissingRuntimePathError, statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { FsChangeEvent } from '../../../shared/filesystem-entry-types'
import {
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

const MISSING = 'missing'
const UNKNOWN = 'unknown'
// Why: a dead SSH or runtime connection can leave a stat unanswered; treat it as unreadable rather than wait on it.
export const CATCH_UP_STAT_TIMEOUT_MS = 10_000

/** size:mtime per open file path, taken while the watch was still live. */
export type EditorWatchDiskBaseline = ReadonlyMap<string, string>

function collectWatchedOpenFilePaths(target: EditorExternalWatchTarget): string[] {
  const paths = new Set<string>()
  for (const file of useAppStore.getState().openFiles) {
    if (
      file.worktreeId === target.worktreeId &&
      getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId &&
      isExternalReloadableEditorTab(file) &&
      // Why: files outside the root were never covered by this watch, and may live on another host.
      relativePathInsideRoot(target.worktreePath, file.filePath) !== null
    ) {
      paths.add(file.filePath)
    }
  }
  return [...paths]
}

async function readDiskStamp(target: EditorExternalWatchTarget, filePath: string): Promise<string> {
  try {
    const stat = await statRuntimePath(
      {
        settings: target.runtimeEnvironmentId
          ? { activeRuntimeEnvironmentId: target.runtimeEnvironmentId }
          : null,
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        connectionId: target.connectionId
      },
      filePath
    )
    return stat.isDirectory ? MISSING : `${stat.size}:${stat.mtime}`
  } catch (error) {
    return isMissingRuntimePathError(error) ? MISSING : UNKNOWN
  }
}

function statDiskStamp(target: EditorExternalWatchTarget, filePath: string): Promise<string> {
  return withTimeout(readDiskStamp(target, filePath), CATCH_UP_STAT_TIMEOUT_MS, UNKNOWN)
}

async function statDiskStamps(
  target: EditorExternalWatchTarget,
  filePaths: readonly string[]
): Promise<Map<string, string>> {
  const stamps = await Promise.all(filePaths.map((filePath) => statDiskStamp(target, filePath)))
  return new Map(filePaths.map((filePath, index) => [filePath, stamps[index]]))
}

export function captureEditorWatchDiskBaseline(
  target: EditorExternalWatchTarget
): Promise<EditorWatchDiskBaseline> {
  return statDiskStamps(target, collectWatchedOpenFilePaths(target))
}

export type EditorWatchCatchUpResult = {
  events: FsChangeEvent[]
  /** Baseline entries the host couldn't answer for yet; re-check them later. */
  unresolved: EditorWatchDiskBaseline
}

/** Synthesizes the watcher events a target missed while unwatched, so they take the live event path. */
export async function collectEditorWatchCatchUpEvents(
  target: EditorExternalWatchTarget,
  baseline: EditorWatchDiskBaseline
): Promise<EditorWatchCatchUpResult> {
  // Why: files opened while unwatched have no cached content yet; their first reveal reads fresh.
  const filePaths = collectWatchedOpenFilePaths(target).filter((filePath) => baseline.has(filePath))
  const current = await statDiskStamps(target, filePaths)
  const events: FsChangeEvent[] = []
  const unresolved = new Map<string, string>()
  for (const [filePath, stamp] of current) {
    const before = baseline.get(filePath)
    if (stamp === UNKNOWN) {
      // Why: an unreadable stat now can't prove a change, nor rule one out.
      unresolved.set(filePath, before ?? UNKNOWN)
      continue
    }
    // Why: an unreadable baseline can't rule a change out.
    if (stamp === before) {
      continue
    }
    const kind = stamp === MISSING ? 'delete' : before === MISSING ? 'create' : 'update'
    events.push({ kind, absolutePath: filePath })
  }
  return { events, unresolved }
}

/** Suspends autosave on the target's tabs until the catch-up lands, so a fast edit on return can't overwrite a missed write. */
export function holdEditorAutosaveDuringCatchUp(
  target: EditorExternalWatchTarget,
  baseline: EditorWatchDiskBaseline
): () => void {
  const state = useAppStore.getState()
  const heldFileIds = state.openFiles
    .filter(
      (file) =>
        file.worktreeId === target.worktreeId &&
        getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId &&
        baseline.has(file.filePath) &&
        canAutoSaveOpenFile(file) &&
        // Why: a move echo verification already owns this flag and clears it itself.
        file.pendingLiveDiskVerification !== true
    )
    .map((file) => file.id)
  for (const fileId of heldFileIds) {
    state.setPendingLiveDiskVerification(fileId, true)
  }
  let released = false
  return () => {
    // Why: released by both the timeout and the catch-up; a second release could clear a later, unrelated hold.
    if (released) {
      return
    }
    released = true
    const current = useAppStore.getState()
    for (const fileId of heldFileIds) {
      current.setPendingLiveDiskVerification(fileId, false)
    }
  }
}
