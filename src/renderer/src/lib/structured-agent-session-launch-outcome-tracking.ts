import { StructuredAgentSessionSubmissionEndedError } from './structured-agent-session-launch-errors'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { readNativeChatNewDraft, retireNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import { clearNativeChatComposerDraftIfUnchanged } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  settleStructuredLaunchCallers,
  structuredLaunchCallersHavePendingWork
} from '@/lib/structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from '@/lib/structured-agent-session-launch-recovery'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import {
  getStructuredLaunchStateBySessionId,
  deleteStructuredLaunchStateIfCurrent,
  notifyStructuredLaunchListeners,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'

// How a launch's create outcome settles its callers: published, refused, failed or unknown.

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

const finalizing = new WeakMap<StructuredLaunchState, Promise<void>>()

export async function finalizeStructuredLaunchConfirmedSubmission(sessionId: string): Promise<void> {
  const draft = readNativeChatNewDraft(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId) ??
    (draft ? restorePersistedStructuredLaunchState(draft.owner.workspaceId, sessionId) : undefined)
  if (state?.intent.firstSubmission && !state.cancelled) {
    await finalizeStructuredLaunchFirstSubmission(state)
  }
}

export function finalizeStructuredLaunchFirstSubmission(state: StructuredLaunchState): Promise<void> {
  const active = finalizing.get(state)
  if (active) {
    return active
  }
  const finalized = finalizeFirstSubmission(state).finally(() => finalizing.delete(state))
  finalizing.set(state, finalized)
  return finalized
}

async function finalizeFirstSubmission(state: StructuredLaunchState): Promise<void> {
  const submission = state.intent.firstSubmission
  if (!submission || !(await retireNativeChatNewDraft(state.intent.sessionId))) {
    return
  }
  clearNativeChatComposerDraftIfUnchanged(`agent-session:${state.intent.sessionId}`, submission.draft)
  delete state.intent.firstSubmission
  settleStructuredLaunchCallers(state.callers, 'published')
  maybeCleanupLaunchState(state)
  notifyStructuredLaunchListeners()
}

export function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (
    state.intent.firstSubmission ||
    state.callers.outcome === 'failed' ||
    structuredLaunchCallersHavePendingWork(state.callers) ||
    Object.keys(state.selection.held).length > 0
  ) {
    return
  }
  cleanupLaunchState(state)
}

function settleStructuredLaunchRefusal(state: StructuredLaunchState): void {
  if (state.callers.outcome !== 'pending' && state.callers.outcome !== 'unknown') {
    return
  }
  retireStructuredAgentSessionLaunchCancellationTombstone(
    state.intent.worktreeId,
    state.intent.sessionId
  )
  settleStructuredLaunchCallers(state.callers, 'failed')
  notifyStructuredLaunchListeners()
}

export function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    (receipt) => {
      if (state.promise !== promise || getStructuredLaunchStateBySessionId(state.intent.sessionId) !== state) {
        return
      }
      settleStructuredLaunchCallers(state.callers, 'published')
      if (receipt.firstMessage?.clientMessageId === state.intent.firstSubmission?.clientMessageId) {
        void finalizeStructuredLaunchFirstSubmission(state)
      }
      notifyStructuredLaunchListeners()
    },
    (error) => {
      if (state.promise !== promise || getStructuredLaunchStateBySessionId(state.intent.sessionId) !== state) {
        return
      }
      if (state.cancelled) {
        if (error instanceof StructuredAgentSessionCreateRefusalError) {
          retireStructuredAgentSessionLaunchCancellationTombstone(
            state.intent.worktreeId,
            state.intent.sessionId
          )
        }
        return
      }
      if (error instanceof StructuredAgentSessionSubmissionEndedError) {
        state.cancelled = true
        state.visibilityUnknown = false
        settleStructuredLaunchCallers(state.callers, 'failed')
        delete state.intent.firstSubmission
        cleanupLaunchState(state)
        return
      }
      // The chat's Retry line owns the failed start's guidance.
      console.warn('[native-chat] structured launch failed', error)
      const failure = structuredLaunchFailure(error)
      if (failure) {
        state.failure = failure
      } else {
        delete state.failure
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleStructuredLaunchRefusal(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallers(state.callers, 'failed')
        notifyStructuredLaunchListeners()
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}
