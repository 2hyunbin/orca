import { installPaneTerminalInterfacePresentation } from './pane-terminal-interface-presentation'
import { readTerminalInterface } from '../../native-chat/terminal-interface-presentation'
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
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'

import {
  paneShouldAnswerOscColorQueries,
  resolvePaneLaunchAgentCandidate,
  type PaneLaunchAgentPaneSlice
} from './pane-launch-agent-candidate'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'
import {
  installAgentDeparture,
  readPaneDepartureState,
  readPaneObservationOwner
} from './agent-departure'
import { isObservationOwnerSuperseded } from '../pane-foreground-agent-tracker-contract'

export function installPaneAgentIdentity(session: ConnectPanePtySession): void {
  installPaneTerminalInterfacePresentation(session)
  // One launch ladder serves finish confirmation, visible sampling and OSC color-reply suppression.
  const panePane = (): PaneLaunchAgentPaneSlice => ({
    worktreeId: session.deps.worktreeId,
    tabId: session.deps.tabId,
    paneKey: session.cacheKey,
    startup: session.paneStartup
  })
  const resolveLaunchAgentCandidate = (
    state: ReturnType<typeof useAppStore.getState>
  ): string | undefined => resolvePaneLaunchAgentCandidate(state, panePane())
  session.paneExpectsLaunchAgent = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    Boolean(resolveLaunchAgentCandidate(state))
  // Seed fresh-spawn confirmation for recognized agents on no-OSC shells such as Git Bash/cmd.
  session.resolveExpectedLaunchTuiAgent = (): TuiAgent | null => {
    const candidate = resolveLaunchAgentCandidate(useAppStore.getState())
    return isTuiAgent(candidate) ? candidate : null
  }
  // jcode themes itself; early OSC color replies can appear as composer text, so both main and renderer skip them.
  session.shouldAnswerPaneOscColorQueries = (): boolean =>
    paneShouldAnswerOscColorQueries(useAppStore.getState(), panePane())
  session.clearStaleAgentTabTitleOnConfirmedShell = () =>
    clearStaleAgentTabTitleOnConfirmedShell(session)
  session.deferredCommandFinishedStatusDrop = null
  session.deferredConfirmedShellReconcile = null
  /** Confirmed shell return retires main’s latches using one acceptedStatusSeq anchor across the full ladder; deferred row removal is not newer evidence. A foreign delete/rebuild can reset the ordinal, but command-start already cancels normal relaunch races. */
  session.reconcileEndedProcessIfPaneQuiet = (armedAcceptedStatusSeq: number | undefined): void => {
    const current = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (current && current.acceptedStatusSeq !== armedAcceptedStatusSeq) {
      return
    }
    // Why: main's clear echoes back and would drop the result the deferred drop just kept.
    if (current && isRetainedProgramResult(current)) {
      return
    }
    // Reconcile main-only hook latches retained by live-pane drops; renderer rows/config already belong to the deferred drop, and main echoes its clear.
    window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey)
  }
  session.visibleForegroundSamplePending = false
  session.visibleForegroundSampleSettled = false
  session.settleDeferredCommandFinishedStatusDrop = (
    options: { confirmedShell?: boolean; processExitConfirmed?: boolean } = {}
  ): void => {
    const dropStatus = session.deferredCommandFinishedStatusDrop
    const reconcile = session.deferredConfirmedShellReconcile
    session.deferredConfirmedShellReconcile = null
    if (options.confirmedShell || !dropStatus) {
      session.deferredCommandFinishedStatusDrop = null
      if (options.confirmedShell && dropStatus) {
        dropStatus?.()
        reconcile?.()
      }
      return
    }
    const ptyId = session.transport.getPtyId()
    const incarnation = session.remotePtyIncarnationId
    const owner = readPaneObservationOwner(session)
    const row = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (!readPaneDepartureState(session) || (!row && !options.processExitConfirmed)) {
      session.deferredCommandFinishedStatusDrop = null
      return
    }
    const dropUnlessVerifiable = (verifiable: boolean): void => {
      if (session.deferredCommandFinishedStatusDrop !== dropStatus) {
        return
      }
      session.deferredCommandFinishedStatusDrop = null
      const state = readPaneDepartureState(session)
      const current = state?.agentStatusByPaneKey[session.cacheKey]
      if (
        !state ||
        session.transport.getPtyId() !== ptyId ||
        session.remotePtyIncarnationId !== incarnation ||
        isObservationOwnerSuperseded(owner, readPaneObservationOwner(session)) ||
        current?.acceptedStatusSeq !== row?.acceptedStatusSeq ||
        (!current && !options.processExitConfirmed)
      ) {
        return
      }
      if (!verifiable) {
        dropStatus()
        // Why: only a process-table-confirmed exit proves the agent's main-side latches are dead.
        if (options.processExitConfirmed) {
          reconcile?.()
        }
      }
    }
    void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(session.cacheKey))
      .then((verifiable) => dropUnlessVerifiable(verifiable === true))
      .catch(() => dropUnlessVerifiable(false))
  }
  installAgentDeparture(session)
  session.isForegroundTrackingAllowed = (id: string): boolean => {
    if (isRemoteExecutionHostPtyId(id)) {
      return true
    }
    if (!navigator.userAgent.includes('Windows')) {
      return true
    }
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[session.deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === session.deps.tabId
    )
    // WSL/remote panes cannot authorize native ConPTY bytes, so skip Windows scans that cannot affect routing.
    return isLocalNativeWindowsConpty({
      userAgent: navigator.userAgent,
      connectionId: getConnectionId(session.deps.worktreeId) ?? null,
      cwd: session.deps.cwd,
      shellOverride: resolveWindowsShellOverride(
        tab?.shellOverride,
        state.settings?.terminalWindowsShell
      ),
      executionHostId: getExecutionHostIdForWorktree(state, session.deps.worktreeId)
    })
  }
  session.paneForegroundAgentTracker = createPaneForegroundAgentTracker({
    getPtyId: () => session.transport.getPtyId(),
    isTrackablePtyId: session.isForegroundTrackingAllowed,
    readForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id, options) =>
      isRemoteExecutionHostPtyId(id)
        ? inspectRuntimeTerminalProcess(id, options)
        : window.api.pty.confirmForegroundProcess(id),
    isRemotePtyId: isRemoteExecutionHostPtyId,
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null,
    publish: (entry) => useAppStore.getState().setPaneForegroundAgent(session.cacheKey, entry),
    getPublishedEntry: () => useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey],
    // Why lazy: the completion coordinator is installed after this tracker.
    onAgentProcessRead: (process) =>
      session.agentCompletionCoordinator?.observeForegroundAgentProcess(process),
    hasKnownAgentIdentity: () =>
      useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]?.agentEvidence ===
      'process-read',
    hasAgentExpectation: () => {
      const state = useAppStore.getState()
      return session.paneExpectsLaunchAgent(state) || session.paneHasKnownAgentIdentity()
    },
    getObservationOwner: () => readPaneObservationOwner(session),
    onConfirmedShellForeground: (reason) => {
      if (reason === 'command-finished') {
        return session.acceptAgentDeparture('command-finished')
      }
      if (!readTerminalInterface(useAppStore.getState(), session.cacheKey)) {
        return session.acceptAgentDeparture('foreground-release')
      }
    },
    // Wrap callbacks so caller arguments cannot become options that reconcile an unproven exit.
    onCommandFinishedUnavailable: () => session.settleDeferredCommandFinishedStatusDrop(),
    onVisibleForegroundSettled: (outcome) => {
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = outcome !== 'inconclusive'
      if (outcome !== 'inconclusive') {
        return
      }
      const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]
      if (foreground?.routingConfirmationPending !== true) {
        return
      }
      useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
        agent: foreground.agent,
        agentEvidence: foreground.agentEvidence,
        routingRevoked: true,
        shellForeground: foreground.shellForeground
      })
    }
  })
  // Bytes and main facts share command-finished policy to preserve drop/interrupt semantics across authority modes.
  session.handleCommandFinished = (bestEffortExitCode: number | null): void => {
    session.clearCommandInferredPaneAgentAfterPtySideEffects()
    session.visibleForegroundSamplePending = false
    const shouldDeferStatusDrop = session.paneForegroundAgentTracker.onCommandFinished()
    // Commands can change HEAD/index; nudge git UI immediately instead of waiting for polling.
    dispatchTerminalCommandFinishedEvent(session.deps.worktreeId, bestEffortExitCode)
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    const inferenceResult = session.flushPendingInterruptInference()
    const dropStatus = (): void => {
      if (inferenceResult === true) {
        session.dropCommandFinishedStatusIfSameTurn(entry, { allowInferredInterrupt: true })
        return
      }
      if (inferenceResult instanceof Promise) {
        void inferenceResult.then((applied) => {
          session.dropCommandFinishedStatusIfSameTurn(entry, {
            allowInferredInterrupt: applied === true
          })
        })
        return
      }
      session.dropCommandFinishedStatusIfSameTurn(entry)
    }
    if (shouldDeferStatusDrop) {
      // Retain identity through local shell confirmation, anchoring accepted-status ordinal once across the whole retry ladder.
      const armedAcceptedStatusSeq = entry?.acceptedStatusSeq
      session.deferredCommandFinishedStatusDrop =
        entry ||
        state.paneForegroundAgentByPaneKey[session.cacheKey]?.agentEvidence === 'process-read'
          ? dropStatus
          : null
      session.deferredConfirmedShellReconcile = () =>
        session.reconcileEndedProcessIfPaneQuiet(armedAcceptedStatusSeq)
      return
    }
    session.deferredCommandFinishedStatusDrop = null
    session.deferredConfirmedShellReconcile = null
    dropStatus()
  }
  session.sampleVisiblePaneForegroundAgent = (forceRoutingConfirmation = false): void => {
    if (
      !session.deps.isVisibleRef.current ||
      session.visibleForegroundSamplePending ||
      session.visibleForegroundSampleSettled
    ) {
      return
    }
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[session.cacheKey]
    // Reattached display identity lacks routing authority; only fresh evidence can suppress confirmation.
    if (foreground?.agent && foreground.routingTrusted === true) {
      return
    }
    if (!forceRoutingConfirmation && session.paneHasLiveHookAgentIcon(state)) {
      return
    }
    const expectsAgent = session.paneExpectsLaunchAgent(state)
    if (!forceRoutingConfirmation && foreground?.shellForeground) {
      return
    }
    // Tab launch metadata can name a sibling; rebuild pane identity from local process evidence.
    session.visibleForegroundSamplePending =
      session.paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  session.startAcceptedInferredCommand = (agent) => {
    session.agentCompletionCoordinator?.invalidateProcessInspection()
    session.paneForegroundAgentTracker.onCommandStarted(agent)
  }
  session.requestKnownWindowsShiftEnterReconfirmation = () => {
    const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[session.cacheKey]
    // Revoke display-only reattach/launch hints on input or exit evidence until provider confirmation restores routing authority.
    if (
      !foreground?.agent ||
      !isTuiAgent(foreground.agent) ||
      foreground.routingTrusted !== true ||
      TUI_AGENT_CONFIG[foreground.agent].windowsShiftEnterEncoding !== 'csi-u'
    ) {
      return
    }
    // No-OSC shells retain display hints but require fresh provider evidence before byte routing.
    useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
      agent: foreground.agent,
      agentEvidence: foreground.agentEvidence,
      routingRevoked: true,
      shellForeground: false
    })
    session.visibleForegroundSamplePending = false
    session.visibleForegroundSampleSettled = false
    // Hooks can suppress display sampling but cannot restore explicitly revoked byte authority.
    session.sampleVisiblePaneForegroundAgent(true)
    if (session.paneForegroundAgentTracker.hasReadInFlight()) {
      useAppStore.getState().setPaneForegroundAgent(session.cacheKey, {
        agent: foreground.agent,
        agentEvidence: foreground.agentEvidence,
        routingRevoked: true,
        shellForeground: false,
        routingConfirmationPending: true
      })
    }
  }
  session.commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: () => {
      session.agentCompletionCoordinator?.invalidateProcessInspection()
      // Why: a new command invalidates cleanup waiting on the previous D; only
      // a later confirmed process exit may retire this pane's live identity.
      session.deferredCommandFinishedStatusDrop = null
      dismissRetainedProgramResult(session.cacheKey, useAppStore.getState())
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = false
      // Typed aliases may widen confirmation timing but cannot supply routing evidence.
      session.paneForegroundAgentTracker.onCommandStarted(session.commandInferredPaneAgent)
    },
    onCommandFinished: session.handleCommandFinished
  })
  // OSC 133 swallowing is rendering hygiene and stays installed under every side-effect authority.
  session.commandLifecycle.attachXtermConsumer(session.pane.terminal)
}
