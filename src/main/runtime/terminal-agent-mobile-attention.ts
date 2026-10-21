// Share the window policy until host turn-end facts replace residual hook inference.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { isRecognizedAgentType } from '../../shared/agent-process-recognition'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusIpcPayload, AgentStatusState } from '../../shared/agent-status-types'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { createAgentCompletionHookObserver } from '../../shared/agent-completion-hook-observer'
import {
  createAgentCompletionNotificationController,
  type CompletionState
} from '../../shared/agent-completion-notification-controller'
import { createAgentCompletionIdentityScope } from '../../shared/agent-completion-identity-store'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { StructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'

// Match the window's quiet period for a turn that resumes immediately.
export const HOST_HOOK_DONE_QUIET_MS = 1_500

export type TerminalAgentMobileAttentionDeps = {
  readRow: (paneKey: string) => AgentStatusIpcPayload | null
  readNotificationSettings: () => NotificationSettings | undefined
  readWorkspaceLabels: (workspaceId: string) => StructuredAttentionWorkspaceLabels
  isWorkspaceMuted: (workspaceId: string) => boolean
  dispatch: (event: MobileNotificationDispatchEvent) => void
  retire: (worktreeId: string, paneKey: string, before: number) => void
  now: () => number
}

export function createTerminalAgentMobileAttention(deps: TerminalAgentMobileAttentionDeps) {
  const panes = new Map<string, ReturnType<typeof createPane>>()

  const announce = (
    worktreeId: string,
    row: AgentStatusIpcPayload,
    agentState: AgentStatusState,
    notificationId: string
  ): void => {
    if (deps.isWorkspaceMuted(worktreeId)) {
      return
    }
    const settings = deps.readNotificationSettings()
    if (!settings) {
      return
    }
    let labels: StructuredAttentionWorkspaceLabels = {}
    try {
      labels = deps.readWorkspaceLabels(worktreeId)
    } catch {
      // Missing labels must not block delivery.
    }
    const outcome = agentState === 'done' ? agentMainAgentVerdict(row) : null
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      ...labels,
      agentState,
      ...(row.agentType ? { agentType: row.agentType } : {}),
      ...(row.prompt ? { agentPrompt: row.prompt } : {}),
      ...(row.toolName ? { agentToolName: row.toolName } : {}),
      ...(row.toolInput ? { agentToolInput: row.toolInput } : {}),
      ...(row.lastAssistantMessage ? { agentLastAssistantMessage: row.lastAssistantMessage } : {}),
      ...(outcome ? { agentTurnOutcome: outcome } : {})
    }
    const { title, body } = buildNotificationOptions(
      request,
      getRuntimeDesktopSurface().translateNotification
    )
    const desktopAllowed = settings.enabled && settings.agentTaskComplete
    deps.dispatch({
      type: 'notification',
      emittedAt: deps.now(),
      source: 'agent-task-complete',
      ...(!desktopAllowed ? { desktopAllowed: false } : {}),
      title,
      body,
      worktreeId,
      notificationId,
      agentState,
      hostAgentAlert: true
    })
  }

  const createPane = (paneKey: string, worktreeId: string) => {
    const identityScope = createAgentCompletionIdentityScope(paneKey, 'hook')
    const state: CompletionState = {
      currentTurn: 0,
      workingStatusObserved: false,
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
    const emit = (
      snapshot: Parameters<
        ReturnType<typeof createAgentCompletionHookObserver>['observeHookStatus']
      >[0]
    ) => {
      const row = deps.readRow(paneKey)
      const id = buildAgentNotificationId({
        worktreeId,
        paneKey,
        stateStartedAt: snapshot.stateStartedAt
      })
      if (row && id) {
        announce(worktreeId, { ...row, ...snapshot }, snapshot.state, id)
      }
    }
    const notification = createAgentCompletionNotificationController({
      options: {
        paneKey,
        isLive: () => panes.has(paneKey),
        dispatchCompletion: (_title, meta) => {
          const row = meta?.agentStatus ?? deps.readRow(paneKey)
          if (row) {
            emit(row)
          }
        },
        dispatchAttention: (_title, meta) => emit(meta.agentStatus)
      },
      state,
      identityScope,
      processState: { processSession: 0, lastForegroundAgent: null, hasAgentRunEvidence: true }
    })
    const observer = createAgentCompletionHookObserver({
      options: { paneKey },
      state,
      establishAgentEvidence: () => {},
      recordPaneActivity: () => {},
      dropPendingTitle: () => {},
      clearPendingHookDone: notification.clearPendingHookDone,
      dispatchAttention: notification.dispatchAttention,
      dispatchCompletion: notification.dispatchCompletion,
      scheduleHookDoneCompletion: notification.scheduleHookDoneCompletion,
      doneShouldUseQuietWindow: notification.doneShouldUseQuietWindow,
      hookCompletionIdentity: notification.hookCompletionIdentity,
      hookCompletionAgentIdentity: notification.hookCompletionAgentIdentity,
      completionIdentityFor: notification.completionIdentityFor,
      openStampedTail: identityScope.openStampedTail,
      rememberHandledTurnCompletedAt: identityScope.rememberTurnCompletedAt,
      turnCompletedAtAlreadyHandled: identityScope.turnCompletedAtAlreadyHandled,
      consumePendingStampedTailForAgent: identityScope.consumePendingStampedTailForAgent,
      consumeStampedTailForCurrentCoordinator: identityScope.consumeStampedTail,
      clearOriginStampedTail: identityScope.clearOriginStampedTail,
      clearProcessExitCompletion: identityScope.clearProcessExitCompletion,
      recordWorkingBoundary: identityScope.recordWorkingBoundary
    })
    return { worktreeId, state, observer, identityScope, notification }
  }

  const observe = (change: AgentPaneChange): void => {
    if (change.kind === 'moved') {
      return
    }
    const { paneKey } = change
    const row = deps.readRow(paneKey)
    const previous = panes.get(paneKey)
    if (
      !row ||
      !change.workspace ||
      row.structuredHost ||
      row.programStatusOnly ||
      row.providerSessionOnly ||
      !isRecognizedAgentType(row.agentType)
    ) {
      previous?.notification.clearPendingHookDone()
      previous?.identityScope.dispose(false)
      panes.delete(paneKey)
      return
    }
    const worktreeId = row.worktreeId ?? change.workspace.worktreeId
    // Live or replayed current facts can retire old news; unconfirmed hydration cannot.
    if (row.state === 'working' && !row.restoredUnconfirmed) {
      deps.retire(worktreeId, paneKey, Math.max(row.turnStartedAt ?? 0, row.stateStartedAt))
    }
    const pane = previous ?? createPane(paneKey, worktreeId)
    panes.set(paneKey, pane)
    const identity = pane.notification.hookCompletionIdentity(row)
    const unseenReplay =
      row.isReplay === true &&
      previous !== undefined &&
      ((row.state === 'working' && row.turnCompletedAt !== undefined) ||
        (row.state === 'done' && identity !== pane.state.lastCompletionIdentity?.identity))
    if (change.kind === 'seeded' && !unseenReplay) {
      pane.state.lastCompletionIdentity = identity
        ? { source: 'hook', identity, agentIdentity: row.agentType ?? null }
        : null
      if (row.turnCompletedAt !== undefined) {
        pane.identityScope.rememberTurnCompletedAt(row.turnCompletedAt)
      }
      if (row.state === 'working' && !row.restoredUnconfirmed) {
        pane.observer.seedHookStatus(row)
      }
      return
    }
    pane.observer.observeHookStatus(row)
  }
  return {
    observe,
    dispose: () => {
      for (const pane of panes.values()) {
        pane.notification.clearPendingHookDone()
        pane.identityScope.dispose(false)
      }
      panes.clear()
    }
  }
}
