import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

/** No workspaces: the host reads what is on screen from the open sessions, and this only says
 *  whether the user is present (0 away, null back). */
export function phonePresenceView(state: AppStateStatus): {
  workspaceIds: string[]
  tabIds: string[]
  presentForMs: number | null
} {
  return { workspaceIds: [], tabIds: [], presentForMs: state === 'active' ? null : 0 }
}

/**
 * Tells the session's host when the phone leaves and returns to the foreground, so a locked or
 * backgrounded phone stops muting the host's unread dot at once instead of when its socket closes.
 */
export function usePhonePresenceReport(client: RpcClient | null, connState: ConnectionState): void {
  useEffect(() => {
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || !client || connState !== 'connected') {
      return
    }
    // An older or switch-off host refuses the method; it then holds the session until close as before.
    const report = (state: AppStateStatus): void => {
      void client.sendRequest('sidebarInputs.reportView', phonePresenceView(state)).catch(() => {})
    }
    // Said on every connect too: a change missed while disconnected must not leave the host stale.
    let wasActive = AppState.currentState === 'active'
    report(AppState.currentState)
    const subscription = AppState.addEventListener('change', (state) => {
      const isActive = state === 'active'
      if (isActive !== wasActive) {
        wasActive = isActive
        report(state)
      }
    })
    return () => subscription.remove()
  }, [client, connState])
}
