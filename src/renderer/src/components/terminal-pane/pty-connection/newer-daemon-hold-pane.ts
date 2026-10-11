import { holdPaneForNewerDaemon, type HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Holds a restored pane main refused to spawn because a newer Orca build's daemon may still run
 * its session. The pane keeps whatever the layout restore painted, read-only, until the hold
 * releases it into `reconnect`.
 */
export function holdForNewerDaemon(
  session: ConnectPanePtySession,
  reconnect: () => Promise<HeldPaneReopenOutcome>
): void {
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> HELD FOR NEWER DAEMON`)
  const generation = session.transportStreamGeneration
  const terminal = session.pane.terminal
  // Why: nothing backs this pane, so keystrokes have nowhere to go.
  terminal.options.disableStdin = true
  const forget = holdPaneForNewerDaemon(session.cacheKey, {
    resumable: Boolean(session.buildColdRestoreAgentResumeStartup()),
    release: async () => {
      forget()
      if (
        session.disposed ||
        generation !== session.transportStreamGeneration ||
        session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
      ) {
        return { reopened: false, agentResumed: false }
      }
      terminal.options.disableStdin = false
      return reconnect()
    }
  })
  session.waitTeardowns.push(forget)
}
