// Layout-owner build: a pane main is starting a terminal for waits and then attaches to it, and a
// start that failed shows why. Neither starts a terminal of its own.

import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const waiting = new WeakSet<ConnectPanePtySession>()

/** Whether the pane waits on main's start; `connect` runs once main's start for it ends. */
export function waitsForMainPaneStart(
  session: ConnectPanePtySession,
  connect: () => void
): boolean {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return false
  }
  const startOf = () => useAppStore.getState().terminalPaneStartsByPaneKey[session.cacheKey]
  const start = startOf()
  if (!start) {
    return false
  }
  if (waiting.has(session)) {
    return true
  }
  waiting.add(session)
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> WAIT FOR MAIN START (${start.status})`)
  let shown = start
  const showFailure = (): void => {
    if (shown.status === 'failed' && !session.disposed) {
      session.deps.onPtyErrorRef?.current?.(
        session.pane.id,
        `The terminal could not start: ${shown.reason ?? 'unknown error'}`
      )
    }
  }
  showFailure()
  const unsubscribe = useAppStore.subscribe((state) => {
    const next = state.terminalPaneStartsByPaneKey[session.cacheKey]
    if (next === shown) {
      return
    }
    if (next) {
      shown = next
      showFailure()
      return
    }
    // Main's start ended: the pane is bound to its terminal now, or main took it back.
    unsubscribe()
    waiting.delete(session)
    const index = session.waitTeardowns.indexOf(unsubscribe)
    if (index !== -1) {
      session.waitTeardowns.splice(index, 1)
    }
    if (!session.disposed) {
      connect()
    }
  })
  session.waitTeardowns.push(unsubscribe)
  return true
}
