// What the runtime knows of a mail holder's turn: a chat's from its host, a terminal agent's from
// its PTY incarnation and the hook server's row for its pane.

import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { DeliveryHolder } from './orchestration/db/messages/delivery-holder-store'
import type { DeliveryHolderReader, HolderTurnEnd } from './orchestration/delivery-holder'
import {
  currentTerminalHookRow,
  type TerminalHookRow,
  type TerminalHookRowDeps
} from './runtime-terminal-hook-row'

type TerminalHolder = Extract<DeliveryHolder, { kind: 'terminal' }>

/**
 * A terminal agent's turn, read off its pane's PTY and its hooks. A new PTY process cut the turn
 * that held the mail. A new conversation in the same shell (`/clear`, a fresh agent, a restart)
 * proves nothing about how the held turn ended, since the hook row keeps only the current one, so
 * it reads unknown rather than re-feed handled mail. An agent without hooks shows nothing past its PTY.
 */
export function terminalHolderTurnEnd(
  holder: TerminalHolder,
  live: { incarnation: string | null; row: TerminalHookRow | undefined }
): HolderTurnEnd {
  // A pane with no terminal yet (not restored, or closed) proves nothing about its PTY.
  if (live.incarnation === null) {
    return 'unknown'
  }
  if (live.incarnation !== holder.processIncarnation) {
    return 'cut'
  }
  const conversation = live.row?.providerSession?.id
  if (
    holder.agentTurnStartedAt === null ||
    !live.row ||
    (holder.agentSessionId && conversation && conversation !== holder.agentSessionId)
  ) {
    return 'unknown'
  }
  if (live.row.turnStartedAt !== holder.agentTurnStartedAt) {
    return 'ended'
  }
  const main = live.row.mainAgent
  if (!main || main.state !== 'done') {
    return 'running'
  }
  return main.outcome === 'cancellation'
    ? 'stopped'
    : main.outcome === 'interruption' || main.outcome === 'failure'
      ? 'cut'
      : 'ended'
}

type TerminalAgentFacts = TerminalHookRowDeps & {
  getTerminalProcessIncarnation: (handle: string) => string | null
  getTerminalHandleForPaneKey: (paneKey: string) => string | null
  getRuntimeId: () => string
}

/** What a `check` from this terminal records. Null without a pane or a PTY. */
function terminalDeliveryHolder(deps: TerminalAgentFacts, handle: string): TerminalHolder | null {
  const paneKey = deps.getTerminalPaneKey(handle)
  const incarnation = deps.getTerminalProcessIncarnation(handle)
  if (!paneKey || !incarnation) {
    return null
  }
  const row = currentTerminalHookRow(deps, handle)
  return {
    kind: 'terminal',
    paneKey,
    processIncarnation: incarnation,
    agentSessionId: row?.providerSession?.id ?? null,
    agentTurnStartedAt: row?.turnStartedAt ?? null
  }
}

export function createDeliveryHolderReader(deps: TerminalAgentFacts): DeliveryHolderReader {
  return {
    holderOf: ({ sessionId, handle }) => {
      if (!sessionId) {
        return terminalDeliveryHolder(deps, handle)
      }
      const turn = getStructuredAgentSessionHost()?.currentWork(sessionId)?.activeTurn()
      return turn ? { kind: 'session', sessionId, turnItemId: turn.item.itemId } : null
    },
    sessionTurns: async (sessionId) =>
      (await getStructuredAgentSessionHost()?.heldTurns(sessionId)) ?? null,
    terminalTurnEnd: (holder) => {
      // The pane's handle this launch: the one the holder ran under may be from an earlier launch.
      const handle = deps.getTerminalHandleForPaneKey(holder.paneKey)
      return terminalHolderTurnEnd(holder, {
        incarnation: handle ? deps.getTerminalProcessIncarnation(handle) : null,
        row: handle ? currentTerminalHookRow(deps, handle) : undefined
      })
    },
    runtimeId: deps.getRuntimeId
  }
}
