// A replayed turn written as the chat's lane writes a live one: the same translator and assembler,
// so its rows carry exactly the keys and bodies a live turn would have, into a staging overlay.

import type { AgentType } from '../../shared/agent-types'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { AcpHistoryJournalOverlay } from './acp-history-journal-overlay'
import type { AcpHistoryTurnIdentity, AcpIdentifiedHistoryTurn } from './acp-history-replay'
import { AcpTimelineTranslator } from './acp-timeline-translator'

/** The chat a replay belongs to. */
export type AcpHistoryScope = {
  /** Orca's session id. */
  sessionId: string
  agent: AgentType
  providerSessionId: string
  dialect: AcpDialect
  /** How the agent names each turn it replays. */
  identity: AcpHistoryTurnIdentity
  now: () => number
}

/** History has no live prompt: a turn opens under the agent's own id, and one the agent's frames
 *  left open ends with the replay, which is all of it there is. */
class AcpHistoryTranslator extends AcpTimelineTranslator {
  openHistoryTurn(turn: string, at: number): ProviderTimelineEvent[] {
    return this.start(turn, at)
  }

  endHistoryTurn(turn: string, at: number): ProviderTimelineEvent[] {
    return this.activeTurn === turn ? this.endTurn(turn, 'end_turn', at, undefined, undefined) : []
  }
}

/** Each turn gets its own translator and assembler, so its rows are keyed the same on every open. */
export function translateHistoryTurn(
  scope: AcpHistoryScope,
  overlay: AcpHistoryJournalOverlay,
  turn: AcpIdentifiedHistoryTurn
): void {
  const translator = new AcpHistoryTranslator({
    sessionId: scope.providerSessionId,
    dialect: scope.dialect
  })
  const assembler = createProviderTimelineAssembler({
    sink: overlay.sink,
    sessionId: scope.sessionId,
    agent: scope.agent,
    generation: `history:${turn.turn}`,
    namespace: scope.providerSessionId,
    schedule: () => () => {}
  })
  const at = turn.startedAt ?? scope.now()
  const apply = (events: readonly ProviderTimelineEvent[]) => {
    for (const event of events) {
      if (!assembler.apply(event).admission.accepted) {
        throw new Error('history-not-admitted')
      }
    }
  }
  try {
    apply(translator.openHistoryTurn(turn.turn, at))
    if (turn.user.length > 0) {
      apply([
        {
          type: 'item.update',
          item: `user:${turn.turn}`,
          body: { kind: 'message', role: 'user', blocks: turn.user },
          join: { thread: scope.providerSessionId, turn: turn.turn }
        }
      ])
    }
    for (const frame of turn.frames) {
      apply(translator.notification(frame.method, frame.params, at))
    }
    apply(translator.endHistoryTurn(turn.turn, at))
    assembler.flush()
  } finally {
    assembler.dispose()
    translator.dispose()
  }
}

/** A journal with no rows, for writing a turn whole whatever the chat already holds. */
export function emptyJournal(epoch: string): StructuredAgentSessionTransitionJournal {
  return {
    epoch,
    canonicalItemId: (itemId) => itemId,
    item: () => null,
    itemBody: () => null,
    visitItems: () => {},
    visitItemsWithLinkage: () => {}
  }
}
