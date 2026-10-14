/**
 * The WSL move's terminal gate (mover design, section 3.2): every pane in scope is either safe to
 * pause and restore on the host, or it blocks the move with the actions that would unblock it.
 * Nothing is ever ended to make progress. Unlike SSH, the local daemon can prove exit, so a pane it
 * cannot answer for is `unverifiable` and blocks rather than being guessed at.
 */
import type { AgentStatusState } from '../../../shared/agent-status-types'
import {
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
} from '../../../shared/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'

export type WslMovePaneFacts = {
  paneKey: string
  /** The daemon's foreground-process probe, the one the close-tab warning uses. */
  foreground: 'shell-idle' | 'process-running' | 'unverifiable'
  /** The agent in the pane, if any, as the hook server reports it. */
  agent?: { state: AgentStatusState; resumable: boolean }
  scrollbackBytes: number
}

export type WslMoveGateInputs = {
  panes: readonly WslMovePaneFacts[]
  /** Automation runs in scope that have not finished. */
  runningAutomationRunIds: readonly string[]
  /** Orchestration dispatches in scope that have not finished. */
  activeDispatchIds: readonly string[]
}

export type WslMoveGateAction = 'wait' | 'end' | 'skip-project' | 'clear-scrollback'

export type WslMoveGateBlocker = {
  kind:
    | 'agent-working'
    | 'process-running'
    | 'agent-not-resumable'
    | 'unverifiable'
    | 'automation-running'
    | 'dispatch-running'
    | 'scrollback-too-large'
  ids: string[]
  actions: WslMoveGateAction[]
}

export type WslMoveGateVerdict =
  | { verdict: 'ready'; paneKeys: string[] }
  | { verdict: 'blocked'; blockers: WslMoveGateBlocker[] }

export function assessWslMoveTerminals(inputs: WslMoveGateInputs): WslMoveGateVerdict {
  const blockers = new Map<WslMoveGateBlocker['kind'], WslMoveGateBlocker>()
  const block = (kind: WslMoveGateBlocker['kind'], id: string, actions: WslMoveGateAction[]) => {
    const existing = blockers.get(kind)
    if (existing) {
      existing.ids.push(id)
    } else {
      blockers.set(kind, { kind, ids: [id], actions })
    }
  }
  for (const pane of inputs.panes) {
    if (pane.foreground === 'unverifiable') {
      block('unverifiable', pane.paneKey, ['wait', 'skip-project'])
    } else if (pane.agent?.state === 'working' || pane.agent?.state === 'waiting') {
      // Mid-turn, or holding a permission prompt ('waiting') a restart would lose. 'blocked' means
      // failed, which resumes like any settled turn.
      block('agent-working', pane.paneKey, ['wait', 'end'])
    } else if (pane.agent && !pane.agent.resumable) {
      block('agent-not-resumable', pane.paneKey, ['end', 'skip-project'])
    } else if (!pane.agent && pane.foreground === 'process-running') {
      block('process-running', pane.paneKey, ['end', 'skip-project'])
    }
    if (pane.scrollbackBytes > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
      block('scrollback-too-large', pane.paneKey, ['clear-scrollback'])
    }
  }
  for (const id of inputs.runningAutomationRunIds) {
    block('automation-running', id, ['wait'])
  }
  for (const id of inputs.activeDispatchIds) {
    block('dispatch-running', id, ['wait'])
  }
  // Over the transfer's caps is a blocker, never a truncation.
  const total = inputs.panes.reduce((sum, pane) => sum + pane.scrollbackBytes, 0)
  const withScrollback = inputs.panes.filter((pane) => pane.scrollbackBytes > 0)
  if (
    !blockers.has('scrollback-too-large') &&
    (total > MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES ||
      withScrollback.length > MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS)
  ) {
    blockers.set('scrollback-too-large', {
      kind: 'scrollback-too-large',
      ids: withScrollback.map((pane) => pane.paneKey),
      actions: ['clear-scrollback']
    })
  }
  return blockers.size > 0
    ? { verdict: 'blocked', blockers: [...blockers.values()] }
    : { verdict: 'ready', paneKeys: inputs.panes.map((pane) => pane.paneKey) }
}
