import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import type { HistoryReader } from './agent-session-history-page-bounds'

/** Replacement catch-up retains proof of a destructive row skipped by its bounded tail. */
export function readAgentSessionCatchUpSnapshot(
  journal: AgentSessionJournal,
  cursor: AgentJournalCursor,
  fence: number,
  reader: HistoryReader
): AgentSessionHistoryResult {
  const frontier = journal.context.destructiveFrontier()
  const page = readAgentSessionHydrationPage(journal, fence, reader)
  return frontier.epoch === cursor.epoch && frontier.sequence > cursor.sequence
    ? { ok: false, reset: 'cursor_compacted', page }
    : { ok: true, page }
}
