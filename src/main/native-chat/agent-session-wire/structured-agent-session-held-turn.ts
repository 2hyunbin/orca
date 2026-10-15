// How a chat turn that was handed orchestration mail ended, as the mailbox reads it. Derived on
// every read from the turn record and the host's current-work projection, never stored.
//   running: the turn is still the live generation's running turn; it has the mail in hand.
//   ended: it finished. The agent decided with the mail in hand.
//   stopped: a person's Stop or close ended it (`cancellation`). Nothing offers its mail again.
//   cut-restart / cut: it ended with nobody asking, through an Orca runtime this one replaced, or
//     otherwise (provider death or error, eviction, a context clear, a send that superseded it).
//   unknown: no record, or its owner may still be running out of this host's sight.

import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { OrchestrationMailNotice } from '../../../shared/agent-session-message-source'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

export type StructuredHeldTurnEnd =
  | 'running'
  | 'ended'
  | 'stopped'
  | 'cut-restart'
  | 'cut'
  | 'unknown'

export type StructuredHeldTurnReader = {
  sessionId: string
  /** How the turn whose record is item `turnItemId` ended. */
  end: (turnItemId: string) => StructuredHeldTurnEnd
  /** The mail notice that opened the newest turn, with how that turn ended; null for any other. */
  newestTurnNotice: () => { end: StructuredHeldTurnEnd; notice: OrchestrationMailNotice } | null
}

function heldTurnEnd(
  work: StructuredAgentSessionCurrentWork,
  journal: Pick<AgentSessionJournal, 'stopMarks'>,
  item: AgentJournalRenderItem | null
): StructuredHeldTurnEnd {
  const turn = item ? readAgentJournalTurn(item.body) : null
  if (!item || !turn || turn.state === 'unverifiable') {
    return 'unknown'
  }
  const cut = work.ranUnderReplacedRuntime(item.itemId) ? 'cut-restart' : 'cut'
  if (turn.state === 'running') {
    if (work.isCurrentItem(item.itemId)) {
      return 'running'
    }
    // Its end not yet written: a person's Stop that decides it (a refused interrupt kills the
    // child before the cancellation lands) is theirs; an owner out of sight decides nothing.
    if (journal.stopMarks.personStopDecides(turn.turnId)) {
      return 'stopped'
    }
    // As the current-work projection reads it: a death it saw first, then an unseen owner.
    const died = work.diedTurn()?.item.itemId === item.itemId
    return !died && work.ownerUnverifiableFor(item.itemId) ? 'unknown' : cut
  }
  // A provider error ended it before it could act on the mail: cut, under the same bound.
  if (turn.state === 'completed') {
    return turn.outcome === 'failure' ? cut : 'ended'
  }
  return turn.outcome === 'cancellation' ? 'stopped' : cut
}

function mailNotice(body: AgentJournalMessageItem | null): OrchestrationMailNotice | null {
  const orchestration = body?.from?.orchestration
  return orchestration?.message === 'mail-notice' ? orchestration : null
}

/** Opens a conversation the idle sweep closed to read it, which starts no agent. */
export async function readStructuredHeldTurns(
  conversation: (sessionId: string) => Promise<{ journal: AgentSessionJournal }>,
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null,
  sessionId: string
): Promise<StructuredHeldTurnReader | null> {
  const { journal } = await conversation(sessionId)
  const work = currentWork(sessionId)
  return work ? structuredHeldTurnReader(sessionId, journal, work) : null
}

function structuredHeldTurnReader(
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'item' | 'itemByKey' | 'newestTurnItem' | 'stopMarks'>,
  work: StructuredAgentSessionCurrentWork
): StructuredHeldTurnReader {
  return {
    sessionId,
    end: (turnItemId) => heldTurnEnd(work, journal, journal.item(turnItemId)),
    newestTurnNotice: () => {
      const item = journal.newestTurnItem()
      const opener = readAgentJournalTurn(item?.body)?.userItemId
      const body = opener ? journal.itemByKey(opener)?.body : undefined
      const notice = mailNotice(body?.kind === 'message' ? body : null)
      return notice ? { end: heldTurnEnd(work, journal, item), notice } : null
    }
  }
}
