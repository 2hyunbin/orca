import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { useAppStore } from '@/store'
import { retireLiveAgentRowOnConfirmedProcessExit } from './confirmed-process-exit-row-retire'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The known agent that owns this pane now; async reads are stale only once another one does. */
export function readPaneObservationOwner(session: ConnectPanePtySession): string | null {
  const agentType = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.agentType
  return agentType && agentType !== 'unknown' ? agentType : null
}

/** One accepted departure per pane: a shell return releases the chat view; only a confirmed
 *  process exit retires lifetime state (row, launch config, sleeping duplicates). */
export function installAgentDeparture(session: ConnectPanePtySession): void {
  session.acceptAgentDeparture = (
    kind: 'foreground-release' | 'process-exit' | 'title',
    process?: RecognizedAgentProcess
  ): boolean => {
    const state = useAppStore.getState()
    const ptyId = session.transport.getPtyId()
    const sleeping = session.getSleepingRecordForPane(state)
    const wake = session.hibernatedWakeTarget
    const current = state.agentStatusByPaneKey[session.cacheKey]
    if (
      session.disposed ||
      !ptyId ||
      state.suppressedPtyExitIds[ptyId] ||
      session.deps.isPtyShutdownPending(ptyId) ||
      session.restartReplacementPtyId === ptyId ||
      (wake && wake.record === sleeping?.record && wake.ptyId === ptyId) ||
      (process &&
        current?.agentType &&
        current.agentType !== 'unknown' &&
        resolveCompatibleAgentTypeForOwner(current.agentType, process.agent) !== process.agent)
    ) {
      return false
    }
    if (
      kind === 'foreground-release' &&
      state.paneForegroundAgentByPaneKey[session.cacheKey]?.shellForeground
    ) {
      return true
    }
    // Shell ownership releases input; only a separately confirmed death retires lifetime state.
    session.deferredCommandFinishedStatusDrop = null
    session.deferredConfirmedShellReconcile = null
    if (kind === 'foreground-release') {
      session.paneForegroundAgentTracker.onShellForegroundObserved()
    } else if (kind === 'process-exit' && process) {
      session.paneForegroundAgentTracker.onProcessExitConfirmed(process)
      if (sleeping) {
        session.clearSleepingRecordProviderDuplicates(state, sleeping)
      }
      state.clearAgentLaunchConfig(session.cacheKey)
      retireLiveAgentRowOnConfirmedProcessExit(session, process)
    }
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    if (kind !== 'title') {
      session.clearStaleAgentTabTitleOnConfirmedShell()
      session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = false
    }
    return true
  }
}
