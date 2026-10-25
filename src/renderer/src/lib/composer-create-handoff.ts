import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from '@/lib/worktree-creation-flow'

// Why: composer preflight (PR fetch, hook checks, settings writes) can stall on
// the network; past this delay the sidebar row owns the submit so the modal closes.
export const COMPOSER_CREATE_HANDOFF_DELAY_MS = 1_500

export type ComposerCreateHandoff = {
  /** Starts creation, continuing the staged sidebar row when one exists. */
  start: (request: WorktreeCreationRequest) => void
  /** True once the composer closed and a staged sidebar row owns the submit. */
  isHandedOff: () => boolean
  /** Ends the handoff window; returns true when it dropped a staged row nothing started. */
  dispose: () => boolean
}

export function scheduleComposerCreateHandoff({
  stagingRequest,
  onHandOff,
  isCancelled,
  delayMs = COMPOSER_CREATE_HANDOFF_DELAY_MS
}: {
  /** Display-only placeholder; never executed, so Retry cannot run it. */
  stagingRequest: WorktreeCreationRequest
  onHandOff: () => void
  isCancelled: () => boolean
  delayMs?: number
}): ComposerCreateHandoff {
  let stagedCreationId: string | null = null
  let started = false
  let disposed = false
  const timer = setTimeout(() => {
    if (started || disposed || isCancelled()) {
      return
    }
    stagedCreationId = beginBackgroundWorktreePreparation(stagingRequest)
    onHandOff()
  }, delayMs)

  return {
    start: (request) => {
      clearTimeout(timer)
      started = true
      if (stagedCreationId === null) {
        runBackgroundWorktreeCreation(request)
        return
      }
      // A false result means the user cancelled the staged row; honor it.
      continueBackgroundWorktreeCreation(stagedCreationId, request)
    },
    isHandedOff: () => stagedCreationId !== null,
    dispose: () => {
      clearTimeout(timer)
      disposed = true
      if (started || stagedCreationId === null) {
        return false
      }
      const store = useAppStore.getState()
      if (!store.pendingWorktreeCreations[stagedCreationId]) {
        return false
      }
      store.removePendingWorktreeCreation(stagedCreationId)
      return true
    }
  }
}
