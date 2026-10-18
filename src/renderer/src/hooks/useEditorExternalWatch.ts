import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { verifyLatchedEditorMoveDestinations } from './editor-external-watch-disk-verification'
import {
  getEditorExternalWatchScopeKey,
  holdEditorWatchUntilReleased,
  isWatchInstalled,
  releaseEditorWatch,
  toWatchWorktreeArgs,
  type HeldEditorWatches
} from './editor-external-watch-handoff'
import {
  armEditorTabDiskVerification,
  reloadCleanEditorTabs
} from './editor-external-watch-activation-reverify'

function warnExternalWatchFailure(target: EditorExternalWatchTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

/** Keeps editor filesystem subscriptions alive beyond any individual editor surface. */
export function useEditorExternalWatch(): void {
  const { targets, targetsKey } = useAppStore(selectEditorExternalWatchTargets)
  const targetsRef = useRef<EditorExternalWatchTarget[]>([])
  const latestTargetsRef = useRef<EditorExternalWatchTarget[]>(targets)
  latestTargetsRef.current = targets
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  const heldWatchesRef = useRef<HeldEditorWatches>(new Map())
  const fsChangedHandlerRef = useRef<
    ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  >(null)

  // Why: diff targets so unchanged worktrees keep their subscription; full teardown on every store change drops events in the gap.
  useEffect(() => {
    const nextTargets = latestTargetsRef.current
    const previousTargets = targetsRef.current
    const previousKeys = new Set(previousTargets.map(getEditorExternalWatchTargetKey))
    const nextKeys = new Set(nextTargets.map(getEditorExternalWatchTargetKey))
    const removed = previousTargets.filter(
      (target) => !nextKeys.has(getEditorExternalWatchTargetKey(target))
    )
    const added = nextTargets.filter(
      (target) => !previousKeys.has(getEditorExternalWatchTargetKey(target))
    )

    targetsRef.current = nextTargets

    const held = heldWatchesRef.current
    const pendingWatchByScope = new Map<
      string,
      { target: EditorExternalWatchTarget; installed: Promise<boolean> }
    >()
    for (const target of added) {
      if (target.runtimeEnvironmentId) {
        subscribeRuntimeTarget(target, remoteWatchUnsubsRef.current, fsChangedHandlerRef)
        continue
      }
      pendingWatchByScope.set(getEditorExternalWatchScopeKey(target), {
        target,
        installed: window.api.fs
          .watchWorktree(toWatchWorktreeArgs(target))
          .then(isWatchInstalled, (err) => {
            // Why: SSH providers can disappear while tabs still reference the worktree; report the failure without an uncaught renderer promise.
            warnExternalWatchFailure(target, err)
            return false
          })
      })
    }
    const narrowedScopes = new Set<string>()
    for (const target of removed) {
      const key = getEditorExternalWatchTargetKey(target)
      const remoteUnsubscribe = remoteWatchUnsubsRef.current.get(key)
      if (remoteUnsubscribe) {
        remoteUnsubscribe()
        remoteWatchUnsubsRef.current.delete(key)
        continue
      }
      const scopeKey = getEditorExternalWatchScopeKey(target)
      if (target.narrowFiles) {
        narrowedScopes.add(scopeKey)
      }
      const replacement = pendingWatchByScope.get(scopeKey)
      if (!replacement) {
        releaseEditorWatch(target, nextTargets, held)
        continue
      }
      // Why: a recursive↔narrow switch releases the old watch only once its replacement is live, so the workspace is never unwatched.
      void replacement.installed.then((installed) => {
        const replacementKey = getEditorExternalWatchTargetKey(replacement.target)
        const replacementCurrent = targetsRef.current.some(
          (current) => getEditorExternalWatchTargetKey(current) === replacementKey
        )
        if (!installed && replacementCurrent) {
          holdEditorWatchUntilReleased(target, replacement.target, held)
        } else {
          releaseEditorWatch(target, targetsRef.current, held)
        }
      })
    }
    for (const target of added) {
      const scopeKey = getEditorExternalWatchScopeKey(target)
      const replacement = pendingWatchByScope.get(scopeKey)
      if (replacement && !target.narrowFiles && narrowedScopes.has(scopeKey)) {
        // Why: arm now, not after the full-tree install — autosave must not run during a long crawl.
        armEditorTabDiskVerification(target)
        void replacement.installed.then(() => reloadCleanEditorTabs(target))
      }
    }
    // Why: final unmount cleanup owns teardown so target changes remain differential.
  }, [targetsKey])

  // Why: one stable fs:changed listener prevents target-key changes from opening an event-loss gap.
  useEffect(() => {
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const heldWatches = heldWatchesRef.current
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(
      (worktreePath, runtimeEnvironmentId) =>
        targetsRef.current.find(
          (target) =>
            normalizeRuntimePathForComparison(target.worktreePath) ===
              normalizeRuntimePathForComparison(worktreePath) &&
            target.runtimeEnvironmentId === runtimeEnvironmentId
        )
    )
    const unsubscribe = window.api.fs.onFsChanged((payload) => handleFsChanged(payload, null))
    fsChangedHandlerRef.current = handleFsChanged

    return () => {
      unsubscribe()
      dispose()
      fsChangedHandlerRef.current = null
      for (const target of targetsRef.current) {
        const key = getEditorExternalWatchTargetKey(target)
        const remoteUnsubscribe = remoteWatchUnsubs.get(key)
        if (remoteUnsubscribe) {
          remoteUnsubscribe()
        } else {
          void window.api.fs.unwatchWorktree(toWatchWorktreeArgs(target))
        }
      }
      for (const riders of heldWatches.values()) {
        for (const target of riders) {
          void window.api.fs.unwatchWorktree(toWatchWorktreeArgs(target))
        }
      }
      heldWatches.clear()
      remoteWatchUnsubs.clear()
      targetsRef.current = []
      // Why: module-scoped reload timers survive StrictMode's synthetic cleanup; a late reload dispatch is harmless.
    }
  }, [])
}

function subscribeRuntimeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>,
  fsChangedHandlerRef: {
    current: ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  }
): void {
  const runtimeEnvironmentId = target.runtimeEnvironmentId
  if (!runtimeEnvironmentId) {
    return
  }
  const key = getEditorExternalWatchTargetKey(target)
  remoteWatchUnsubs.set(
    key,
    subscribeEditorRuntimeFileWatch(
      { ...target, runtimeEnvironmentId },
      (payload) => fsChangedHandlerRef.current?.(payload, runtimeEnvironmentId),
      (error) => warnExternalWatchFailure(target, error)
    )
  )
}

export function verifyLatchedMoveDestinations(
  ...args: Parameters<typeof verifyLatchedEditorMoveDestinations>
): void {
  verifyLatchedEditorMoveDestinations(...args)
}
