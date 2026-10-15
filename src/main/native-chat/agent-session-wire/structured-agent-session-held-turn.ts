// How a chat turn that was handed orchestration mail ended, as the mailbox reads it. Derived on
// every read from the turn record and the host's current-work projection, never stored.
//   running: the turn is still the live generation's running turn; it has the mail in hand.
//   ended: it finished (whatever the provider's verdict). The agent decided with the mail in hand.
//   stopped: a person's Stop or close ended it (`cancellation`). Nothing offers its mail again.
//   cut-restart / cut: it ended with nobody asking, through an Orca runtime this one replaced, or
//     otherwise (provider death, eviction, a context clear, a send that superseded it).
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
  /** How the turn whose record is item `turnItemId` ended. */
  end: (turnItemId: string) => StructuredHeldTurnEnd
  /** The mail notice that opened the newest turn, with how that turn ended; null for any other. */
  newestTurnNotice: () => { end: StructuredHeldTurnEnd; notice: OrchestrationMailNotice } | null
}

function heldTurnEnd(
  work: StructuredAgentSessionCurrentWork,
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
    return work.diedTurn()?.item.itemId === item.itemId
      ? cut
      : work.ownerUnverifiableFor(item.itemId)
        ? 'unknown'
        : cut
  }
  if (turn.state === 'completed') {
    return 'ended'
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
  return work ? structuredHeldTurnReader(journal, work) : null
}

function structuredHeldTurnReader(
  journal: Pick<AgentSessionJournal, 'item' | 'itemByKey' | 'newestTurnItem'>,
  work: StructuredAgentSessionCurrentWork
): StructuredHeldTurnReader {
  return {
    end: (turnItemId) => heldTurnEnd(work, journal.item(turnItemId)),
    newestTurnNotice: () => {
      const item = journal.newestTurnItem()
      const opener = readAgentJournalTurn(item?.body)?.userItemId
      const body = opener ? journal.itemByKey(opener)?.body : undefined
      const notice = mailNotice(body?.kind === 'message' ? body : null)
      return notice ? { end: heldTurnEnd(work, item), notice } : null
    }
  }
}
