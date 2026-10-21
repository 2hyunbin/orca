import { useAppStore } from '@/store'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { createTerminalForegroundPolicy } from './pane-agent-identity'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPaneAgentIdentity(session: ConnectPanePtySession): void {
  const policy = createTerminalForegroundPolicy({
    paneKey: session.cacheKey,
    worktreeId: session.deps.worktreeId,
    tabId: session.deps.tabId,
    cwd: session.deps.cwd,
    startup: session.paneStartup,
    getPtyId: () => session.transport.getPtyId(),
    getExpectedIncarnationId: () => session.remotePtyIncarnationId ?? null,
    isVisible: () => session.deps.isVisibleRef.current,
    getCommandInferredAgent: () => session.commandInferredPaneAgent,
    observeForegroundAgentProcess: (process) =>
      session.agentCompletionCoordinator?.observeForegroundAgentProcess(process),
    clearCommandInferredPaneAgentAfterPtySideEffects: () =>
      session.clearCommandInferredPaneAgentAfterPtySideEffects(),
    flushPendingInterruptInference: () => session.flushPendingInterruptInference(),
    dropCommandFinishedStatusIfSameTurn: (entry, options) =>
      session.dropCommandFinishedStatusIfSameTurn(entry, options),
    onConfirmedShellForeground: (reason) => {
      // Retire stale agent occupancy when a normal exit returns to the shell.
      const state = useAppStore.getState()
      const sleepingRecord = session.getSleepingRecordForPane(state)
      const ptyId = session.transport.getPtyId()
      const wake = session.hibernatedWakeTarget
      // A delayed shell read can settle after exit consumes suppression; preserve only that PTY's exact wake record.
      const isHibernationWakeRecord =
        (ptyId && state.suppressedPtyExitIds[ptyId]) ||
        (wake && wake.record === sleepingRecord?.record && (ptyId === null || wake.ptyId === ptyId))
      if (sleepingRecord && !isHibernationWakeRecord) {
        session.clearSleepingRecordProviderDuplicates(state, sleepingRecord)
      }
      session.clearStaleAgentTabTitleOnConfirmedShell()
      // Why: a hard-killed agent leaves mouse/focus/kitty modes armed, and the
      // surviving shell then receives pointer moves as typed SGR reports; the
      // replay guard keeps xterm's auto-replies from leaking to the shell.
      session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
      // Why: no 133;D backs these proofs, so a deferred command-finished drop keeps its own read.
      if (reason === 'visible-pty' || reason === 'process-exit') {
        state.clearAgentLaunchConfig(session.cacheKey)
      }
    }
  })
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(policy))
  session.clearStaleAgentTabTitleOnConfirmedShell = () =>
    clearStaleAgentTabTitleOnConfirmedShell(session)
  // OSC swallowing remains attached to this view's parser.
  session.commandLifecycle.attachXtermConsumer(session.pane.terminal)
}
