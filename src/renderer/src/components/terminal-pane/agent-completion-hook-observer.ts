import { isRecognizedAgentType } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import {
  createAgentCompletionIdentityScope,
  type LastCompletionIdentity
} from './agent-completion-identity-store'
import {
  createAgentCompletionNotificationController,
  type CompletionState
} from './agent-completion-notification-controller'

type HookObserverState = {
  workingStatusObserved: boolean
  requiresFreshWorking: boolean
  currentTurn: number
  lastCompletionIdentity: LastCompletionIdentity | null
  lastAttentionToken: string | null
  lastCompletionSource: 'hook' | 'title' | 'process-exit' | null
  lastCompletedTurn: number | null
  lastCompletionAt: number
  pendingHookDoneTimer: ReturnType<typeof setTimeout> | null
}

type HookObserverOptions = {
  options: AgentCompletionCoordinatorOptions
  state: HookObserverState
  establishAgentEvidence: () => void
  recordPaneActivity: () => void
  clearPendingHookDone: () => void
  dispatchAttention: (payload: AgentCompletionStatusSnapshot) => void
  dispatchCompletion: ReturnType<
    typeof createAgentCompletionNotificationController
  >['dispatchCompletion']
  scheduleHookDoneCompletion: (title: string, payload: AgentCompletionStatusSnapshot) => void
  doneShouldUseQuietWindow: (payload: AgentCompletionStatusSnapshot) => boolean
  hookCompletionIdentity: (payload: AgentCompletionStatusSnapshot) => string | null
  hookCompletionAgentIdentity: (payload: AgentCompletionStatusSnapshot) => string | null
  completionIdentityFor: (state: string, agentType: string | undefined, timestamp: number) => string
  openStampedTail: (timestamp: number) => boolean
  rememberHandledTurnCompletedAt: (timestamp: number) => void
  turnCompletedAtAlreadyHandled: (timestamp: number) => boolean
  consumePendingStampedTailForAgent: ReturnType<
    typeof createAgentCompletionIdentityScope
  >['consumePendingStampedTailForAgent']
  consumeStampedTailForCurrentCoordinator: (timestamp: number) => void
  clearOriginStampedTail: () => void
  clearProcessExitCompletion: () => void
  recordWorkingBoundary: (timestamp: number | undefined) => void
  dropPendingTitle: () => void
}

function isFiniteTurnCompletedAt(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAttentionHookState(state: AgentCompletionStatusSnapshot['state']): boolean {
  return state === 'waiting' || state === 'blocked'
}

export function createAgentCompletionHookObserver({
  options,
  state,
  establishAgentEvidence,
  recordPaneActivity,
  clearPendingHookDone,
  dispatchAttention,
  dispatchCompletion,
  scheduleHookDoneCompletion,
  doneShouldUseQuietWindow,
  hookCompletionIdentity,
  hookCompletionAgentIdentity,
  completionIdentityFor,
  openStampedTail,
  rememberHandledTurnCompletedAt,
  turnCompletedAtAlreadyHandled,
  consumePendingStampedTailForAgent,
  consumeStampedTailForCurrentCoordinator,
  clearOriginStampedTail,
  clearProcessExitCompletion,
  recordWorkingBoundary,
  dropPendingTitle
}: HookObserverOptions) {
  function observeHookStatus(payload: AgentCompletionStatusSnapshot): void {
    recordPaneActivity()
    if (isRecognizedAgentType(payload.agentType)) {
      establishAgentEvidence()
    }
    if (payload.state === 'working') {
      const turnCompletedAt = isFiniteTurnCompletedAt(payload.turnCompletedAt)
        ? payload.turnCompletedAt
        : undefined
      if (turnCompletedAt !== undefined) {
        const alreadyHandled = openStampedTail(turnCompletedAt)
        if (
          state.workingStatusObserved &&
          !alreadyHandled &&
          state.lastCompletionIdentity?.lastTurnCompletedAtNotified !== turnCompletedAt
        ) {
          const completionSnapshot = {
            ...payload,
            state: 'done' as const,
            turnCompletedAt
          }
          const identity: LastCompletionIdentity = {
            source: 'hook',
            identity: completionIdentityFor('done', payload.agentType, turnCompletedAt),
            agentIdentity: hookCompletionAgentIdentity(payload),
            lastTurnCompletedAtNotified: turnCompletedAt
          }
          if (
            dispatchCompletion('hook', payload.agentType ?? options.paneKey, {
              notifyWithoutLifecycle: true,
              agentStatus: completionSnapshot,
              completionIdentity: identity
            })
          ) {
            state.lastCompletionIdentity = identity
          }
        } else if (!state.workingStatusObserved) {
          rememberHandledTurnCompletedAt(turnCompletedAt)
        }
        options.dispatchHookLifecycle?.(payload)
        return
      }
      clearOriginStampedTail()
      // Exit identity must not suppress later turns of the same agent.
      clearProcessExitCompletion()
      recordWorkingBoundary(payload.stateStartedAt)
      clearPendingHookDone()
      state.workingStatusObserved = true
      state.requiresFreshWorking = false
      state.lastCompletionIdentity = null
      state.lastAttentionToken = null
      state.currentTurn += 1
      dropPendingTitle()
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (isAttentionHookState(payload.state)) {
      clearPendingHookDone()
      dispatchAttention(payload)
      return
    }
    if (payload.state === 'done' && payload.sessionBoundary === true) {
      return
    }
    if (payload.state !== 'done') {
      return
    }
    const identity = hookCompletionIdentity(payload)
    const turnCompletedAt = isFiniteTurnCompletedAt(payload.turnCompletedAt)
      ? payload.turnCompletedAt
      : undefined
    if (
      turnCompletedAt === undefined &&
      consumePendingStampedTailForAgent(hookCompletionAgentIdentity(payload), identity, payload)
    ) {
      state.lastCompletionIdentity = identity
        ? { source: 'hook', identity, agentIdentity: hookCompletionAgentIdentity(payload) }
        : null
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (
      turnCompletedAt !== undefined &&
      (turnCompletedAtAlreadyHandled(turnCompletedAt) ||
        state.lastCompletionIdentity?.lastTurnCompletedAtNotified === turnCompletedAt ||
        state.lastCompletedTurn === state.currentTurn)
    ) {
      consumeStampedTailForCurrentCoordinator(turnCompletedAt)
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (
      identity &&
      state.lastCompletionIdentity?.source === 'hook' &&
      identity === state.lastCompletionIdentity.identity
    ) {
      if (state.pendingHookDoneTimer !== null) {
        scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
      }
      return
    }
    if (
      !state.workingStatusObserved &&
      state.lastCompletionSource === 'hook' &&
      state.lastCompletedTurn === state.currentTurn &&
      // Why: a new host turn-end stamp is a real end even right after a banner; replays restate it.
      (Date.now() - state.lastCompletionAt >= 1_000 || payload.turnEndedAt !== undefined)
    ) {
      state.currentTurn += 1
    }
    state.lastCompletionIdentity = identity
      ? { source: 'hook', identity, agentIdentity: hookCompletionAgentIdentity(payload) }
      : null
    if (doneShouldUseQuietWindow(payload)) {
      scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
      return
    }
    dispatchCompletion('hook', payload.agentType ?? options.paneKey, {
      agentStatus: payload,
      ...(state.lastCompletionIdentity ? { completionIdentity: state.lastCompletionIdentity } : {})
    })
  }

  return {
    observeHookStatus,
    seedHookStatus: (payload: AgentCompletionStatusSnapshot) => {
      const { turnCompletedAt, ...unstampedPayload } = payload
      if (isFiniteTurnCompletedAt(turnCompletedAt)) {
        rememberHandledTurnCompletedAt(turnCompletedAt)
      }
      observeHookStatus(unstampedPayload)
    }
  }
}

export function createHookOnlyCompletionObserver(input: {
  paneKey: string
  isLive: () => boolean
  workingObserved?: boolean
  dispatch: (snapshot: AgentCompletionStatusSnapshot) => void
}) {
  const identityScope = createAgentCompletionIdentityScope(input.paneKey, 'hook')
  let current: AgentCompletionStatusSnapshot | undefined
  let seeding = false
  let disposed = false
  const state: CompletionState = {
    currentTurn: input.workingObserved ? 1 : 0,
    workingStatusObserved: input.workingObserved === true,
    requiresFreshWorking: false,
    lastCompletionToken: null,
    lastCompletionAt: 0,
    lastCompletedTurn: null,
    lastCompletionSource: null,
    lastCompletionIdentity: null,
    lastAttentionToken: null,
    pendingHookDoneTimer: null,
    pendingHookDoneTitle: null,
    pendingHookDonePayload: null
  }
  const processState = { processSession: 0, lastForegroundAgent: null, hasAgentRunEvidence: false }
  const dispatch = (snapshot: AgentCompletionStatusSnapshot | undefined): void => {
    if (!seeding && !disposed && input.isLive() && snapshot) {
      input.dispatch(snapshot)
    }
  }
  const options: AgentCompletionCoordinatorOptions = {
    paneKey: input.paneKey,
    getPtyId: () => null,
    inspectProcess: async () => ({ foregroundProcess: null, hasChildProcesses: false }),
    isLive: () => !disposed && input.isLive(),
    usesHookTurnEnds: (snapshot) => snapshot.turnEndDisposition === 'identified',
    dispatchCompletion: (_title, meta) => dispatch(meta?.agentStatus ?? current),
    dispatchAttention: (_title, meta) => dispatch(meta.agentStatus)
  }
  const notification = createAgentCompletionNotificationController({
    options,
    state,
    processState,
    identityScope
  })
  const observer = createAgentCompletionHookObserver({
    options,
    state,
    establishAgentEvidence: () => {
      processState.hasAgentRunEvidence = true
    },
    recordPaneActivity: () => {},
    ...notification,
    openStampedTail: identityScope.openStampedTail,
    rememberHandledTurnCompletedAt: identityScope.rememberTurnCompletedAt,
    turnCompletedAtAlreadyHandled: identityScope.turnCompletedAtAlreadyHandled,
    consumePendingStampedTailForAgent: identityScope.consumePendingStampedTailForAgent,
    consumeStampedTailForCurrentCoordinator: identityScope.consumeStampedTail,
    clearOriginStampedTail: identityScope.clearOriginStampedTail,
    clearProcessExitCompletion: identityScope.clearProcessExitCompletion,
    recordWorkingBoundary: identityScope.recordWorkingBoundary,
    dropPendingTitle: () => {}
  })
  return {
    observeHookStatus: (snapshot: AgentCompletionStatusSnapshot) => {
      current = snapshot
      observer.observeHookStatus(snapshot)
    },
    seedHookStatus: (snapshot: AgentCompletionStatusSnapshot) => {
      seeding = true
      current = snapshot
      observer.seedHookStatus(snapshot)
      notification.clearPendingHookDone()
      seeding = false
    },
    dispose: () => {
      disposed = true
      current = undefined
      notification.clearPendingHookDone()
      identityScope.clearWorkingBoundary()
      identityScope.dispose(false)
    }
  }
}
