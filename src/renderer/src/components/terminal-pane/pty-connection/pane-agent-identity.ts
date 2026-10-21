import type { TerminalForegroundServices } from './terminal-foreground-services'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { createTerminalCommandLifecycle } from '../terminal-command-lifecycle'
import { createPaneForegroundAgentTracker } from '../pane-foreground-agent-tracker'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'

import { createTerminalLaunchAgentPolicy } from './terminal-launch-agent-policy'

import type { TerminalAgent } from '../../../../../shared/terminal-agent'

export function createTerminalForegroundPolicy(services: TerminalForegroundServices) {
  const {
    paneHasLiveHookAgentIcon,
    paneExpectsLaunchAgent,
    resolveExpectedLaunchTuiAgent,
    shouldAnswerPaneOscColorQueries
  } = createTerminalLaunchAgentPolicy(services)
  // Why: a launched/hook-known agent pane must confirm — not trust — a 133;D so a
  // full-screen agent's leaked nested-shell 133;D can't clear its tab identity,
  // even on a restore where no command-start read has recorded evidence yet.
  const paneHasKnownAgentIdentity = (): boolean => {
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[services.paneKey]?.identity?.agentType
    return (
      Boolean(state.paneForegroundAgentByPaneKey[services.paneKey]?.agent) ||
      paneHasLiveHookAgentIcon(state) ||
      isTuiAgent(registeredLaunchAgent)
    )
  }
  let deferredCommandFinishedStatusDrop: (() => void) | null = null
  let deferredConfirmedShellReconcile: (() => void) | null = null
  /** The pane's foreground was proven to be a shell, so its agent exited. Unlike a user dismissal,
   *  this must also retire the main-side per-pane caches — a surviving Claude latch resolves the
   *  next event straight back to `working`.
   *
   *  Ordered by the row's `acceptedStatusSeq`, not by row identity or `updatedAt`: the confirming
   *  process read can take seconds, an unrelated field moving in that window is not evidence the
   *  agent is alive, and a genuinely newer row can share the anchor's millisecond. Reading the token
   *  off the row is what makes the ordering safe — the paired drop runs FIRST and removes the row,
   *  and a removed row means nothing reported, not "the anchor is gone".
   *
   *  Residual: a row deleted by some OTHER path mid-window and then rebuilt restarts its count, so a
   *  pane armed at 1 that reports exactly once more compares equal. It needs a foreign drop inside
   *  the confirm window; the relaunch case that would otherwise hit it is already discarded by
   *  onCommandStarted, and the cost is retiring a pane the process table just proved is a shell. */
  const reconcileEndedProcessIfPaneQuiet = (armedAcceptedStatusSeq: number | undefined): void => {
    const current = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
    if (current && current.acceptedStatusSeq !== armedAcceptedStatusSeq) {
      return
    }
    // Why: main's clear echoes back and would drop the result the deferred drop just kept.
    if (current && isRetainedProgramResult(current)) {
      return
    }
    // Why: main-side only. The renderer row and launch config are already owned by the deferred
    // drop above; what that path cannot reach is the hook server's per-pane Claude latches, which
    // `agentStatus:drop` deliberately preserves for a still-live pane. Main echoes its own clear
    // back through the pane-status-cleared channel, so both sides stay consistent.
    window.api?.agentStatus?.reconcileEndedProcess?.(services.paneKey)
  }
  let visibleForegroundSamplePending = false
  let visibleForegroundSampleSettled = false
  const settleDeferredCommandFinishedStatusDrop = (
    options: { confirmedShell?: boolean; processExitConfirmed?: boolean } = {}
  ): void => {
    const dropStatus = deferredCommandFinishedStatusDrop
    const reconcile = deferredConfirmedShellReconcile
    deferredConfirmedShellReconcile = null
    if (options.confirmedShell || !dropStatus) {
      deferredCommandFinishedStatusDrop = null
      if (options.confirmedShell) {
        dropStatus?.()
        reconcile?.()
      }
      return
    }
    // Why: only a pane whose agent process the host can check keeps its row on an unanswered read;
    // every other pane keeps today's cleanup until the renderer reads the owner record (step 2).
    // The drop stays armed while main answers, so a new command start still cancels it.
    const dropUnlessVerifiable = (verifiable: boolean): void => {
      if (deferredCommandFinishedStatusDrop !== dropStatus) {
        return
      }
      deferredCommandFinishedStatusDrop = null
      if (!verifiable) {
        dropStatus()
        // Why: only a process-table-confirmed exit proves the agent's main-side latches are dead.
        if (options.processExitConfirmed) {
          reconcile?.()
        }
      }
    }
    void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(services.paneKey))
      .then((verifiable) => dropUnlessVerifiable(verifiable === true))
      .catch(() => dropUnlessVerifiable(false))
  }
  const isForegroundTrackingAllowed = (id: string): boolean => {
    if (isRemoteExecutionHostPtyId(id)) {
      return true
    }
    if (!navigator.userAgent.includes('Windows')) {
      return true
    }
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[services.worktreeId] ?? []).find(
      (candidate) => candidate.id === services.tabId
    )
    // Why: WSL and remote-runtime panes can never authorize native ConPTY
    // bytes, so do not pay for Windows process scans that cannot affect routing.
    return isLocalNativeWindowsConpty({
      userAgent: navigator.userAgent,
      connectionId: getConnectionId(services.worktreeId) ?? null,
      cwd: services.cwd,
      shellOverride: resolveWindowsShellOverride(
        tab?.shellOverride,
        state.settings?.terminalWindowsShell
      ),
      executionHostId: getExecutionHostIdForWorktree(state, services.worktreeId)
    })
  }
  const paneForegroundAgentTracker = createPaneForegroundAgentTracker({
    getPtyId: () => services.getPtyId(),
    isTrackablePtyId: isForegroundTrackingAllowed,
    readForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.confirmForegroundProcess(id),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => services.getExpectedIncarnationId(),
    publish: (entry) => useAppStore.getState().setPaneForegroundAgent(services.paneKey, entry),
    getPublishedEntry: () => useAppStore.getState().paneForegroundAgentByPaneKey[services.paneKey],
    // Why lazy: the completion coordinator is installed after this tracker.
    onAgentProcessRead: (process) => services.observeForegroundAgentProcess(process),
    hasKnownAgentIdentity: paneHasKnownAgentIdentity,
    onConfirmedShellForeground: (reason) => {
      services.onConfirmedShellForeground(reason)
      if (reason === 'process-exit') {
        visibleForegroundSamplePending = false
        visibleForegroundSampleSettled = false
      }
      if (reason !== 'visible-pty' && reason !== 'process-exit') {
        settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
      }
    },
    // Why wrapped: passed bare, a caller-supplied argument would be read as `options` and could
    // reconcile on the unavailable path, which has no proof the agent exited.
    onCommandFinishedUnavailable: () => settleDeferredCommandFinishedStatusDrop(),
    onVisibleForegroundSettled: (outcome) => {
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = outcome !== 'inconclusive'
      if (outcome !== 'inconclusive') {
        return
      }
      const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[services.paneKey]
      if (foreground?.routingConfirmationPending !== true) {
        return
      }
      useAppStore.getState().setPaneForegroundAgent(services.paneKey, {
        agent: foreground.agent,
        agentEvidence: foreground.agentEvidence,
        routingRevoked: true,
        shellForeground: foreground.shellForeground
      })
    }
  })
  // Why: one command-finished policy whether the signal arrives as bytes
  // (remote PTYs, kill switch off) or as a main-derived pty:sideEffect fact —
  // routing both through this handler keeps the drop/interrupt semantics
  // identical across authority modes.
  const handleCommandFinished = (bestEffortExitCode: number | null): void => {
    services.clearCommandInferredPaneAgentAfterPtySideEffects()
    visibleForegroundSamplePending = false
    const shouldDeferStatusDrop = paneForegroundAgentTracker.onCommandFinished()
    // Why: the finished command may have moved HEAD or the index (e.g.
    // `git checkout`); nudge git UI now instead of waiting for a poll.
    dispatchTerminalCommandFinishedEvent(services.worktreeId, bestEffortExitCode)
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[services.paneKey]
    const inferenceResult = services.flushPendingInterruptInference()
    const dropStatus = (): void => {
      if (inferenceResult === true) {
        services.dropCommandFinishedStatusIfSameTurn(entry, { allowInferredInterrupt: true })
        return
      }
      if (inferenceResult instanceof Promise) {
        void inferenceResult.then((applied) => {
          services.dropCommandFinishedStatusIfSameTurn(entry, {
            allowInferredInterrupt: applied === true
          })
        })
        return
      }
      services.dropCommandFinishedStatusIfSameTurn(entry)
    }
    if (shouldDeferStatusDrop) {
      // Why: keep the concrete pane identity routable while the local process
      // check distinguishes a leaked nested-shell D from a genuine agent exit.
      // Anchor the accepted-status ordinal once, here — not per rung of the confirm ladder, which
      // can span seconds — so the gate tolerates churn across the whole window.
      const armedAcceptedStatusSeq = entry?.acceptedStatusSeq
      deferredCommandFinishedStatusDrop = dropStatus
      deferredConfirmedShellReconcile = () =>
        reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
      return
    }
    deferredCommandFinishedStatusDrop = null
    deferredConfirmedShellReconcile = null
    dropStatus()
  }
  const sampleVisiblePaneForegroundAgent = (forceRoutingConfirmation = false): void => {
    if (!services.isVisible() || visibleForegroundSamplePending || visibleForegroundSampleSettled) {
      return
    }
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[services.paneKey]
    // Why: a daemon reattach may restore display identity without current
    // routing authority. Only fresh evidence can suppress its confirmation.
    if (foreground?.agent && foreground.routingTrusted === true) {
      return
    }
    if (!forceRoutingConfirmation && paneHasLiveHookAgentIcon(state)) {
      return
    }
    const expectsAgent = paneExpectsLaunchAgent(state)
    // Why: a completed local process ladder is stronger than stale tab/startup
    // launch metadata. Command-start clears this mark if the pane becomes busy.
    if (foreground?.shellForeground) {
      return
    }
    // Why: tab launch metadata can leak across split panes; rebuild pane-scoped
    // identity from local process state, with remote/SSH excluded by the tracker.
    visibleForegroundSamplePending = paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  const startAcceptedInferredCommand = (agent: TerminalAgent): void => {
    paneForegroundAgentTracker.onCommandStarted(agent)
  }
  const requestKnownWindowsShiftEnterReconfirmation = () => {
    const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[services.paneKey]
    // Why: daemon reattach/launch metadata is display-only until a live
    // provider read confirms it. Submit/interrupt/title-exit evidence must
    // revoke that launch-only hint too, otherwise Shift+Enter can route bytes
    // to an agent that already exited before confirmation ever ran.
    if (
      !foreground?.agent ||
      !isTuiAgent(foreground.agent) ||
      foreground.routingTrusted !== true ||
      TUI_AGENT_CONFIG[foreground.agent].windowsShiftEnterEncoding !== 'csi-u'
    ) {
      return
    }
    // Why: cmd.exe and Git Bash have no OSC command boundaries. Keep the icon
    // as a hint, but revoke bytes until one current provider confirmation lands.
    useAppStore.getState().setPaneForegroundAgent(services.paneKey, {
      agent: foreground.agent,
      agentEvidence: foreground.agentEvidence,
      routingRevoked: true,
      shellForeground: false
    })
    visibleForegroundSamplePending = false
    visibleForegroundSampleSettled = false
    // Why: hook rows can suppress display-only sampling, but cannot restore
    // byte authority after this function explicitly revoked routing trust.
    sampleVisiblePaneForegroundAgent(true)
    if (paneForegroundAgentTracker.hasReadInFlight()) {
      useAppStore.getState().setPaneForegroundAgent(services.paneKey, {
        agent: foreground.agent,
        agentEvidence: foreground.agentEvidence,
        routingRevoked: true,
        shellForeground: false,
        routingConfirmationPending: true
      })
    }
  }
  const handleCommandStarted = (): void => {
    // Why: a new command invalidates cleanup waiting on the previous D; only
    // a later confirmed shell boundary may retire this pane's live identity.
    deferredCommandFinishedStatusDrop = null
    dismissRetainedProgramResult(services.paneKey, useAppStore.getState())
    visibleForegroundSamplePending = false
    visibleForegroundSampleSettled = false
    // Why: typed commands can be aliases, so they only widen the bounded
    // process-confirmation window; they never become routing evidence.
    paneForegroundAgentTracker.onCommandStarted(services.getCommandInferredAgent())
  }
  const commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: handleCommandStarted,
    onCommandFinished: handleCommandFinished
  })
  return {
    paneHasLiveHookAgentIcon,
    paneExpectsLaunchAgent,
    resolveExpectedLaunchTuiAgent,
    shouldAnswerPaneOscColorQueries,
    paneHasKnownAgentIdentity,
    get deferredCommandFinishedStatusDrop() {
      return deferredCommandFinishedStatusDrop
    },
    set deferredCommandFinishedStatusDrop(value: (() => void) | null) {
      deferredCommandFinishedStatusDrop = value
    },
    get deferredConfirmedShellReconcile() {
      return deferredConfirmedShellReconcile
    },
    set deferredConfirmedShellReconcile(value: (() => void) | null) {
      deferredConfirmedShellReconcile = value
    },
    reconcileEndedProcessIfPaneQuiet,
    get visibleForegroundSamplePending() {
      return visibleForegroundSamplePending
    },
    set visibleForegroundSamplePending(value: boolean) {
      visibleForegroundSamplePending = value
    },
    get visibleForegroundSampleSettled() {
      return visibleForegroundSampleSettled
    },
    set visibleForegroundSampleSettled(value: boolean) {
      visibleForegroundSampleSettled = value
    },
    settleDeferredCommandFinishedStatusDrop,
    isForegroundTrackingAllowed,
    paneForegroundAgentTracker,
    handleCommandFinished,
    sampleVisiblePaneForegroundAgent,
    startAcceptedInferredCommand,
    requestKnownWindowsShiftEnterReconfirmation,
    handleCommandStarted,
    commandLifecycle
  }
}
