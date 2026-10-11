import type { NewerDaemonHold } from '../../../../../shared/newer-daemon-hold'
import { holdPaneForNewerDaemon, type HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Clears the read-only screen and its scrollback so the restore below paints it once.
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
  const release = (onSettled: (outcome: HeldPaneReopenOutcome) => void): void => {
    released = true
    forget()
    if (!isCurrent()) {
      onSettled({ reopened: false, agentResumed: false })
      return
    }
    terminal.options.disableStdin = false
    session.writeReplayData(CLEAR_HELD_SCREEN)
    connect(onSettled)
  }
  // Why: nothing backs this pane, so keystrokes have nowhere to go.
  terminal.options.disableStdin = true
  const forget = holdPaneForNewerDaemon(session.cacheKey, {
    resumable: Boolean(session.buildColdRestoreAgentResumeStartup()),
    release: () => new Promise<HeldPaneReopenOutcome>(release)
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
        release(() => {})
      } else if (hold.restoredScreen) {
        session.writeReplayData(hold.restoredScreen.scrollback)
      }
    })
}
