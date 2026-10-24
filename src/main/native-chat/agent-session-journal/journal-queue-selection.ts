import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import type { JournalSelection } from './journal-selection'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'

export function updateSelectedQueueCard(
  selection: JournalSelection,
  state: JournalReducerState,
  id: string,
  card: QueuedMessageRow | undefined,
  previous: QueuedMessageRow | undefined
): void {
  const reportOf = (row: QueuedMessageRow | undefined) =>
    row?.state === 'returned' && row.body.command && row.consumedAs !== null
      ? agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(row.consumedAs))
      : undefined
  const before = reportOf(previous)
  const after = reportOf(card)
  if (before !== after) {
    if (before !== undefined) {
      selection.groups.update(`report:${before}`, id, false)
      selection.groups.update(
        'readyReports',
        before,
        selection.groups.has(`report:${before}`) && state.items.has(before)
      )
    }
    if (after !== undefined) {
      selection.groups.update(`report:${after}`, id, true)
      selection.groups.update('readyReports', after, state.items.has(after))
    }
  }
  selection.order.update(
    'queuePositions',
    id,
    card ? { sequence: card.position, ordinal: 0 } : undefined
  )
  selection.groups.update(
    'unorderedQueuePositions',
    id,
    card?.position !== undefined && card.position !== card.position
  )
}

export function nextSelectedReportedCard(
  selection: JournalSelection,
  state: JournalReducerState
): string | undefined {
  for (;;) {
    const report = selection.groups.next('readyReports')?.key
    if (report === undefined) {
      return undefined
    }
    const card = state.items.has(report)
      ? selection.groups.next(`report:${report}`)?.key
      : undefined
    if (card !== undefined) {
      return card
    }
    selection.groups.update('readyReports', report, false)
  }
}
