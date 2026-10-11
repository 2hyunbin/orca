import type { NewerDaemonHold } from '../../../../../shared/newer-daemon-hold'
import { holdPaneForNewerDaemon, type HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Clears the history screen the hold painted so the restore below paints it once.
const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'

type ReopenConnect = (onSettled: (outcome: HeldPaneReopenOutcome) => void) => void

/**
 * Holds a restored pane main refused to spawn because a newer Orca build's daemon may still run
 * its session: shows the saved screen read-only until the hold releases it into `connect`.
 */
export function holdForNewerDaemon(
  session: ConnectPanePtySession,
  sessionId: string,
  connect: ReopenConnect
): void {
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> HELD FOR NEWER DAEMON ${sessionId}`)
  const generation = session.transportStreamGeneration
  const terminal = session.pane.terminal
  const isCurrent = (): boolean =>
    !session.disposed &&
    generation === session.transportStreamGeneration &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  let released = false
  // Why: a layout restore already painted this pane's saved buffer; the history screen would repeat it.
  const layoutPainted = session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id)
  let paintedHistory = false
  const release = (): Promise<HeldPaneReopenOutcome> =>
    new Promise((resolve) => {
      released = true
      forget()
      if (!isCurrent()) {
        resolve({ reopened: false, agentResumed: false })
        return
      }
      terminal.options.disableStdin = false
      if (paintedHistory) {
        session.writeReplayData(CLEAR_HELD_SCREEN)
      }
      connect(resolve)
    })
  // Why: nothing backs this pane, so keystrokes have nowhere to go.
  terminal.options.disableStdin = true
  const forget = holdPaneForNewerDaemon(session.cacheKey, {
    resumable: Boolean(session.buildColdRestoreAgentResumeStartup()),
    release
  })
  session.waitTeardowns.push(forget)
  void window.api.pty
    .readNewerDaemonHold(sessionId)
    .catch((): NewerDaemonHold => ({ held: true, restoredScreen: null }))
    .then((hold) => {
      if (released || !isCurrent()) {
        return
      }
      if (!hold.held) {
        // Why: the newer daemon stopped between main's refusal and this read.
        void release()
      } else if (hold.restoredScreen && !layoutPainted) {
        paintedHistory = true
        session.writeReplayData(hold.restoredScreen.scrollback)
      }
    })
}
