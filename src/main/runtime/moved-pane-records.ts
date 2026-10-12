// What follows a pane moved into a new tab beyond the layout: its agent status, its orchestration
// resource and its pane-keyed profile records, all keyed by the pane key the move changed.

import { agentHookServer } from '../agent-hooks/server'
import type { OrchestrationDb } from './orchestration/db'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest
} from '../../shared/terminal-leaf-move'

export function followMovedPane(
  move: TerminalLeafMoveRequest,
  orchestration: OrchestrationDb | null
): void {
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(move)
  try {
    // The process keeps the pane key baked into its env, so status must alias old to new.
    agentHookServer.transferPaneAuthority(
      fromPaneKey,
      toPaneKey,
      move.ptyId ?? undefined,
      Date.now(),
      {
        authorityVerified: true
      }
    )
  } catch (error) {
    console.warn('[pty] moved pane kept its old agent-status key:', error)
  }
  try {
    orchestration?.rekeyWorkerTerminalResourcePaneKey({ fromPaneKey, toPaneKey })
  } catch (error) {
    console.warn('[pty] moved pane kept its old orchestration resource key:', error)
  }
}
