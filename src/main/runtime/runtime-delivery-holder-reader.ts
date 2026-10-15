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
 * A terminal agent's turn, read off its PTY and its hooks. A new PTY process, or a new conversation
 * in the same shell (the agent restarted, or `/clear`), cut the turn that held the mail; an agent
 * without hooks shows nothing past its PTY.
 */
export function terminalHolderTurnEnd(
  holder: TerminalHolder,
  live: { incarnation: string | null; row: TerminalHookRow | undefined }
): HolderTurnEnd {
  // A handle this runtime does not know (re-minted after a restart) proves nothing about the PTY.
  if (live.incarnation === null) {
    return 'unknown'
  }
  if (live.incarnation !== holder.processIncarnation) {
    return 'cut'
  }
  const conversation = live.row?.providerSession?.id
  if (holder.agentSessionId && conversation && conversation !== holder.agentSessionId) {
    return 'cut'
  }
  if (holder.agentTurnStartedAt === null || !live.row) {
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
    : main.outcome === 'interruption'
      ? 'cut'
      : 'ended'
}

/** What a `check` from this terminal records. Null without a PTY. */
function terminalDeliveryHolder(
  deps: TerminalHookRowDeps & { getTerminalProcessIncarnation: (handle: string) => string | null },
  handle: string
): TerminalHolder | null {
  const incarnation = deps.getTerminalProcessIncarnation(handle)
  if (!incarnation) {
    return null
  }
  const row = currentTerminalHookRow(deps, handle)
  return {
    kind: 'terminal',
    handle,
    processIncarnation: incarnation,
    agentSessionId: row?.providerSession?.id ?? null,
    agentTurnStartedAt: row?.turnStartedAt ?? null
  }
}

export function createDeliveryHolderReader(
  deps: TerminalHookRowDeps & {
    getTerminalProcessIncarnation: (handle: string) => string | null
    getRuntimeId: () => string
  }
): DeliveryHolderReader {
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
    terminalTurnEnd: (holder) =>
      terminalHolderTurnEnd(holder, {
        incarnation: deps.getTerminalProcessIncarnation(holder.handle),
        row: currentTerminalHookRow(deps, holder.handle)
      }),
    runtimeId: deps.getRuntimeId
  }
}
