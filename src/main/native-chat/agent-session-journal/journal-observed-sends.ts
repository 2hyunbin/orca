// What a provider said about a send, as the journal saves and reads it (`JournalObservedSend`): its
// exact echo as an `accepted` row, and the turn its answer named as a mark on a fact key no item
// ever takes. Planned against the fold at the batch's own turn in the queue, so a fact already
// saved is not written twice and a send already settled is not reopened.

import {
  isAgentJournalFactKey,
  readAgentJournalSendAnsweredKey
} from '../../../shared/agent-session-journal-item-key'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalRow, JournalTombstoneRow } from './journal-row-schema'
import { buildJournalSendAnsweredRow } from './journal-stop-and-resume-rows'
import type { JournalObservedSend } from './journal-store-contracts'

/** A saved fact: never a removal, and no item for a client. */
export function isJournalFactRow(row: JournalRow): boolean {
  return row.kind === 'tombstone' && isAgentJournalFactKey(row.itemId)
}

/** Folds an answered-turn mark; the first saved for a send stands. */
export function foldJournalSendAnswered(
  sendAnswers: Map<string, string>,
  row: JournalTombstoneRow
): void {
  const clientMessageId = readAgentJournalSendAnsweredKey(row.itemId)
  if (clientMessageId !== null && row.sendAnswered && !sendAnswers.has(clientMessageId)) {
    sendAnswers.set(clientMessageId, row.sendAnswered.turnItemId)
  }
}

/** The rows that save what the fold still lacks of `observed`, at `fence`, and the sends whose
 *  receipt they accept, which no verdict planned beside them may settle otherwise. */
export function planJournalObservedSends(
  state: () => JournalReducerState,
  observed: readonly JournalObservedSend[],
  fence: number
): { rows: ((seq: number, ts: number) => JournalRow)[]; accepted: ReadonlySet<string> } {
  const current = state()
  const accepted = new Set<string>()
  const answered = new Set<string>()
  const rows: ((seq: number, ts: number) => JournalRow)[] = []
  for (const { clientMessageId, epoch, providerIdentity, answeredTurnItemId } of observed) {
    const submission =
      epoch === current.epoch ? current.submissions.get(clientMessageId) : undefined
    if (
      providerIdentity &&
      !accepted.has(clientMessageId) &&
      journalDispatchRowApplies(submission)
    ) {
      accepted.add(clientMessageId)
      rows.push(
        journalDispatchRowBuilder(state, {
          clientMessageId,
          state: 'accepted',
          providerIdentity,
          fence
        })
      )
    }
    // Only a turn the journal holds: an answer may name one that never opens.
    if (
      answeredTurnItemId &&
      current.items.has(answeredTurnItemId) &&
      submission &&
      !answered.has(clientMessageId) &&
      !current.sendAnswers.has(clientMessageId)
    ) {
      answered.add(clientMessageId)
      rows.push((seq, ts) =>
        buildJournalSendAnsweredRow({
          state: state(),
          seq,
          fence,
          ts,
          clientMessageId,
          turnItemId: answeredTurnItemId
        })
      )
    }
  }
  return { rows, accepted }
}
