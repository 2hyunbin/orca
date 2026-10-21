import { createTerminalInputPolicy } from './terminal-input-policy'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { markTerminalBracketedPasteInterrupted } from '../terminal-bracketed-paste'

import { REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installPaneAgentIdentity } from './pane-foreground-policy-bind'

export function installInterruptInputIntent(session: ConnectPanePtySession): void {
  session.scheduleReattachIdleAgentCursorReset = (): void => {
    const status = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
    if (status !== 'idle' && status !== 'permission') {
      return
    }
    session.clearReattachIdleAgentCursorResetTimer()
    session.reattachIdleAgentCursorResetTimer = setTimeout(() => {
      session.reattachIdleAgentCursorResetTimer = null
      if (session.disposed) {
        return
      }
      const latestStatus = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
      if (latestStatus !== 'idle' && latestStatus !== 'permission') {
        return
      }
      // Why: restored idle agent TUIs can repaint after reattach SIGWINCH and
      // reapply DECSCUSR steady-bar; the normal working→idle reset will not
      // fire because the agent was already idle before Orca restarted.
      session.queueAgentIdleTerminalModeReset()
    }, REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS)
  }
  const policy = createTerminalInputPolicy({
    paneKey: session.cacheKey,
    clearInferredInterruptWorkingTitle: () => session.clearInferredInterruptWorkingTitle(),
    observeTitleOnlyInterrupt: () => session.observeTitleOnlyInterrupt(),
    markBracketedPasteInterrupted: () =>
      markTerminalBracketedPasteInterrupted(session.pane.terminal)
  })
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(policy))
  installPaneAgentIdentity(session)
}
