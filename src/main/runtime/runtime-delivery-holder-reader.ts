// What the runtime knows of a mail holder's turn: a chat's from its host, a terminal agent's from
// its pane's PTY process and the hook server's row and ended-turn record for the pane.

import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentEndedOpenTurn } from '../agent-hooks/server/server-ended-open-turns'
import type { TerminalHandOffRef } from './orchestration/db/messages/delivery-holder-store'
import type { DeliveryHolderReader, HolderTurnEnd } from './orchestration/delivery-holder'
import {
  currentTerminalHookRow,
  type TerminalHookRow,
  type TerminalHookRowDeps
} from './runtime-terminal-hook-row'

type TerminalLive = {
  incarnation: string | null
  row: TerminalHookRow | undefined
  /** The last turn the pane's agent process ended mid-way (hook server). */
  endedOpenTurn: AgentEndedOpenTurn | null
}

/** A turn the hook row shows finished: a person's interrupt stopped it; an interruption or a
 *  provider error cut it; anything else ended it. */
function doneTurnEnd(row: TerminalHookRow): HolderTurnEnd {
  const outcome = row.mainAgent?.outcome
  return outcome === 'cancellation'
    ? 'stopped'
    : outcome === 'interruption' || outcome === 'failure'
      ? 'cut'
      : 'ended'
}

/**
 * The turn a terminal hand-off reached. A new PTY process in the pane, or the agent process ending
 * with that turn open (the hook server's record), cut it. A new conversation in the same shell
 * (`/clear`, a fresh agent) with no such record proves nothing about how it ended, since the hook
 * row keeps only the current turn, so it reads unknown rather than re-feed handled mail. An agent
 * without hooks shows nothing past its PTY.
 */
export function terminalHandOffEnd(ref: TerminalHandOffRef, live: TerminalLive): HolderTurnEnd {
  // A pane with no terminal yet (not restored, or closed) proves nothing about its PTY.
  if (live.incarnation === null) {
    return 'unknown'
  }
  if (live.incarnation !== ref.processIncarnation) {
    return 'cut'
  }
  const ended = live.endedOpenTurn
  const row = live.row
  if (ref.kind === 'terminal-notice') {
    // The notice's turn is the agent's first from `typedAt`: one cut, or one the row shows failed.
    if (ended && ended.turnStartedAt >= ref.typedAt) {
      return 'cut'
    }
    const turnStartedAt = row?.turnStartedAt
    const done = row?.mainAgent?.state === 'done'
    return row && turnStartedAt !== undefined && turnStartedAt >= ref.typedAt && done
      ? doneTurnEnd(row)
      : 'unknown'
  }
  if (
    ended &&
    ended.turnStartedAt === ref.agentTurnStartedAt &&
    ended.conversationId === ref.agentSessionId
  ) {
    return 'cut'
  }
  const conversation = row?.providerSession?.id
  if (
    ref.agentTurnStartedAt === null ||
    !row ||
    (ref.agentSessionId && conversation && conversation !== ref.agentSessionId)
  ) {
    return 'unknown'
  }
  if (row.turnStartedAt !== ref.agentTurnStartedAt) {
    return 'ended'
  }
  return row.mainAgent?.state === 'done' ? doneTurnEnd(row) : 'running'
}

type TerminalAgentFacts = TerminalHookRowDeps & {
  getTerminalProcessIncarnation: (handle: string) => string | null
  getTerminalHandleForPaneKey: (paneKey: string) => string | null
  getEndedOpenAgentTurn: (paneKey: string) => AgentEndedOpenTurn | null
  getRuntimeId: () => string
}

/** What a terminal hand-off records: its pane's process and the turn its hooks report. Null
 *  without a pane or a PTY. */
function terminalHandOff(deps: TerminalAgentFacts, handle: string) {
  const paneKey = deps.getTerminalPaneKey(handle)
  const processIncarnation = deps.getTerminalProcessIncarnation(handle)
  if (!paneKey || !processIncarnation) {
    return null
  }
  return { paneKey, processIncarnation, row: currentTerminalHookRow(deps, handle) }
}

export function createDeliveryHolderReader(deps: TerminalAgentFacts): DeliveryHolderReader {
  return {
    holderOf: ({ sessionId, handle }) => {
      if (!sessionId) {
        const terminal = terminalHandOff(deps, handle)
        return terminal
          ? {
              kind: 'terminal',
              paneKey: terminal.paneKey,
              processIncarnation: terminal.processIncarnation,
              agentSessionId: terminal.row?.providerSession?.id ?? null,
              agentTurnStartedAt: terminal.row?.turnStartedAt ?? null
            }
          : null
      }
      // Bookkeeping never fails the `check` it rides on: an unreadable host records no holder.
      try {
        const turn = getStructuredAgentSessionHost()?.currentWork(sessionId)?.activeTurn()
        return turn ? { kind: 'session', sessionId, turnItemId: turn.item.itemId } : null
      } catch {
        return null
      }
    },
    sessionTurns: async (sessionId) =>
      (await getStructuredAgentSessionHost()?.heldTurns(sessionId)) ?? null,
    terminalTurnEnd: (ref) => {
      // The pane's handle this launch: the one the hand-off ran under may be from an earlier launch.
      const handle = deps.getTerminalHandleForPaneKey(ref.paneKey)
      return terminalHandOffEnd(ref, {
        incarnation: handle ? deps.getTerminalProcessIncarnation(handle) : null,
        row: handle ? currentTerminalHookRow(deps, handle) : undefined,
        endedOpenTurn: deps.getEndedOpenAgentTurn(ref.paneKey)
      })
    },
    runtimeId: deps.getRuntimeId
  }
}
