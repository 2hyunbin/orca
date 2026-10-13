// The turn a Stop is about, read once for its event and its note. The note sits on that turn, found
// by the turn's id whether it still runs or has ended, and keyed by it, so a repeated Stop rewrites
// the one row instead of adding one.

import type {
  AgentJournalStatusItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'

/** The turn a Stop is about: the one it named, else the one running when it is read. */
export function structuredAgentSessionStoppedTurnId(
  journal: Pick<AgentSessionJournal, 'activeTurnId'>,
  namedTurnId: string | undefined
): string | null {
  return namedTurnId ?? journal.activeTurnId()
}

/** A Stop names a turn the journal does not show running, as a phone does once that turn ended. */
export function structuredAgentSessionStopNamesTurnNotLive(
  namedTurnId: string | undefined,
  liveTurnId: string | null
): boolean {
  return namedTurnId !== undefined && namedTurnId !== liveTurnId
}

/** The scope of the turn `turnId` names, running or ended; null when the journal has no such turn. */
export function structuredAgentSessionNamedTurnScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): Extract<AgentJournalTurnScope, { kind: 'turn' }> | null {
  const turn = journal
    .snapshot()
    .items.findLast((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
  return turn ? { kind: 'turn', turnItemId: turn.itemId } : null
}

/** The turn the provider says the interrupt took, even one that opened while the cancel waited for
 *  it: the note is that turn's, never a conversation row read before the wait. */
export function structuredAgentSessionStopNoteScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  stoppedTurn: string | undefined,
  fallback: AgentJournalTurnScope
): AgentJournalTurnScope {
  return (
    (stoppedTurn !== undefined
      ? structuredAgentSessionNamedTurnScope(journal, stoppedTurn)
      : null) ?? fallback
  )
}

export function writeStructuredAgentSessionStopNote(
  ctx: {
    journal: AgentSessionJournal
    fence: number
    logger: StructuredAgentSessionLogger
    sessionId: string
  },
  input: {
    identity: ReturnType<typeof structuredAgentSessionStopNoteIdentity>
    body: AgentJournalStatusItem
    stoppedTurn?: string
    fallbackScope: AgentJournalTurnScope
  }
): Promise<void> {
  return ctx.journal
    .appendItem(input.identity, input.body, {
      fence: ctx.fence,
      turnScope: structuredAgentSessionStopNoteScope(
        ctx.journal,
        input.stoppedTurn,
        input.fallbackScope
      )
    })
    .then(() => undefined)
    .catch((error: unknown) =>
      ctx.logger.warn('writing the Stop note failed', {
        scope: 'chat-stop-note',
        sessionId: ctx.sessionId,
        error
      })
    )
}
