// A draft sent back to waiting rests on its submission's "never delivered"
// claim. The provider echoing that message proves the claim wrong: the first
// delivery happened. The reducer keeps such an echo apart (a rejected
// submission may not claim it), so it is read here, from the row itself.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  isProviderUserMessageEcho,
  journalEchoClaimant,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'

/** The waiting drafts this appended row proves were delivered, one per echo: each echo proves one
 *  delivery, so it takes the earliest-positioned match no other echo took, and joins `pairedEchoes`.
 *  The fold calls it before the row applies, for every item row, so a row that is no new provider
 *  echo of a user message returns before anything else is read. */
export function draftsDeliveredByEcho(
  state: JournalReducerState,
  drafts: () => readonly QueuedMessageRow[],
  row: JournalRow,
  pairedEchoes: Set<string>
): string[] {
  const echoes = appendedItems(row).filter(
    (item) =>
      isProviderUserMessageEcho(item.itemId, item.body) &&
      !state.items.has(item.itemId) &&
      !state.aliases.has(item.itemId) &&
      journalEchoClaimant(state, item.itemId, item.body) === null
  )
  if (echoes.length === 0) {
    return []
  }
  const candidates = spentWaitingDrafts(state, drafts()).sort(
    (a, b) => a.draft.position - b.draft.position
  )
  const delivered: string[] = []
  for (const item of echoes) {
    const match = candidates.find(
      (candidate) =>
        !delivered.includes(candidate.draft.messageId) &&
        echoProvesDelivered(state, candidate, item.body, row.seq)
    )
    if (match) {
      delivered.push(match.draft.messageId)
      pairedEchoes.add(item.itemId)
    }
  }
  return delivered
}

/**
 * The same proof for a card that comes to wait again: the earliest echo ALREADY in the journal
 * that proves it delivered and no other card took, or null. An unclaimed echo is the item still
 * stored under its provider id — a claimed one was folded into its submission's item. Reads every
 * item, but only once some hand-off of the card was refused after hand-over, so a card that never
 * left costs nothing.
 */
export function appliedEchoDelivering(
  state: JournalReducerState,
  draft: QueuedMessageRow,
  pairedEchoes: ReadonlySet<string>
): string | null {
  const [candidate] = spentWaitingDrafts(state, [draft])
  if (!candidate) {
    return null
  }
  let earliest: { itemId: string; sequence: number } | null = null
  for (const item of state.items.values()) {
    if (
      isProviderUserMessageEcho(item.itemId, item.body) &&
      !pairedEchoes.has(item.itemId) &&
      (earliest === null || item.sequence < earliest.sequence) &&
      echoProvesDelivered(state, candidate, item.body, item.sequence)
    ) {
      earliest = item
    }
  }
  return earliest?.itemId ?? null
}

type SpentDraft = { draft: QueuedMessageRow; since: number }

/** Waiting drafts some hand-off of which was handed over, then rejected as never delivered;
 *  `since` is the earliest such hand-off's row. A hand-off rejected before hand-over is
 *  provably unwritten: an echo matching it is some other message, and must not delete the card. */
function spentWaitingDrafts(
  state: JournalReducerState,
  drafts: readonly QueuedMessageRow[]
): SpentDraft[] {
  const since = new Map<string, number>()
  for (const submission of state.submissions.values()) {
    if (
      submission.queuedMessageId !== undefined &&
      submission.dispatchState === 'rejected' &&
      submission.handedOverAt !== undefined
    ) {
      const sequence = submission.acceptedSequence ?? 0
      const earliest = since.get(submission.queuedMessageId)
      since.set(submission.queuedMessageId, Math.min(earliest ?? sequence, sequence))
    }
  }
  return drafts.flatMap((draft) => {
    const from = since.get(draft.messageId)
    return draft.state === 'waiting' && from !== undefined ? [{ draft, since: from }] : []
  })
}

/** The one predicate both paths share: an unclaimed echo appended after a disproved hand-off,
 *  carrying the draft's own payload. */
function echoProvesDelivered(
  state: JournalReducerState,
  spent: SpentDraft,
  body: AgentJournalItemBody,
  sequence: number
): boolean {
  return (
    sequence > spent.since &&
    agentSessionSendBodyFingerprint(state.sessionId, body) === spent.draft.fingerprint
  )
}

function appendedItems(row: JournalRow): { itemId: string; body: AgentJournalItemBody }[] {
  if (row.kind === 'item') {
    return [{ itemId: row.itemId, body: row.body }]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.flatMap((mutation) =>
      mutation.kind === 'item' ? [{ itemId: mutation.itemId, body: mutation.body }] : []
    )
  }
  return []
}
