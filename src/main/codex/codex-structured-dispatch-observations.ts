// What this child's Codex said about sends, kept from the moment it is read until the journal
// shows it saved: the exact echo that is a send's receipt, and the turn a successful answer named.
// Each is saved at once and nonfatally; whatever the fold still lacks rides the turn's terminal
// append and the host's exit settlement, so a failed save never stops the reply. The fold is the
// only thing that clears a kept observation. Bounded together with the sends Codex holds: a new
// send always wins, so overflow drops the oldest kept observation. Any loss is this acquisition's,
// never a turn's: no later end of it certifies that its receipts are complete.

import type {
  AgentJournalItemIdentity,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { journalDispatchRowApplies } from '../native-chat/agent-session-journal/journal-dispatch-settlement'
import type { JournalObservedSend } from '../native-chat/agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { MAX_CODEX_PENDING_DISPATCH_ECHOES } from './codex-structured-dispatch-echo'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

/** Unhandled frames that may have been a send's echo. */
const CAPTURE_LOSS_FRAMES = new Set([
  'frame:invalid-json',
  'frame:unclassified',
  'frame:oversized-notification',
  'frame:oversized-unclassified'
])

type ObservationJournal = Pick<
  StructuredAgentSessionTransitionJournal,
  'epoch' | 'submission' | 'sendAnswer'
>

type Kept = JournalObservedSend & { receiptSaving?: true }

export type CodexObservationSave = (
  settlement: { sessionId: string; clientMessageId: string } & (
    | { providerIdentity: AgentJournalItemIdentity }
    | { sendAnswered: { turnItemId: string } }
  )
) => Promise<unknown> | void

export type CodexDispatchObservations = {
  /** An exact echo: kept when the journal shows this generation was handed that send. */
  receipt: (clientMessageId: string, identity: AgentJournalItemIdentity) => void
  /** Saves a kept receipt once; without a journal to check, the armed send admits it. */
  saveReceipt: (clientMessageId: string, identity: AgentJournalItemIdentity, armed: boolean) => void
  /** A successful answer naming the turn Codex chose for the send. */
  answer: (clientMessageId: string, turnId: string) => void
  /** Capture lost something: a lost receipt has no turn, so no later end certifies. */
  lose: () => void
  /** A frame the connection could not deliver. */
  noteFrame: (kind: string) => void
  /** Whether this acquisition's capture is whole. */
  certifies: () => boolean
  retained: () => JournalObservedSend[]
  /** Drops what the fold shows saved, or can no longer save. */
  prune: () => void
  clear: () => void
}

export function createCodexDispatchObservations(input: {
  sessionId: string
  /** This generation's: a send handed over at another is not this child's to receipt. */
  fence: number
  journal: () => ObservationJournal | null
  held: () => ReadonlySet<string>
  save?: CodexObservationSave
}): CodexDispatchObservations {
  const kept = new Map<string, Kept>()
  // Monotonic: a new acquisition gets a new capture.
  let captureLost = false
  let echoed = false
  const lose = (): void => {
    captureLost = true
  }
  // A receipt the journal neither holds nor can still take is lost.
  const loseUnsaved = (
    identity: AgentJournalItemIdentity | undefined,
    submission: AgentJournalSubmission | undefined
  ): void => {
    if (identity && submission?.dispatchState !== 'accepted') {
      lose()
    }
  }
  const prune = (): void => {
    const journal = input.journal()
    if (!journal?.submission || !journal.sendAnswer) {
      return
    }
    for (const [clientMessageId, observed] of kept) {
      const submission =
        observed.epoch === journal.epoch ? journal.submission(clientMessageId) : undefined
      const receiptOwed =
        observed.providerIdentity !== undefined && journalDispatchRowApplies(submission)
      const answerOwed =
        observed.answeredTurnItemId !== undefined &&
        submission !== undefined &&
        journal.sendAnswer(clientMessageId) === undefined
      if (!receiptOwed && !answerOwed) {
        kept.delete(clientMessageId)
        loseUnsaved(observed.providerIdentity, submission)
      }
    }
  }
  // The promise is only a cue: the fold alone says whether the write landed.
  const save = (settlement: Parameters<CodexObservationSave>[0]): void => {
    void Promise.resolve(input.save?.(settlement)).then(prune, prune)
  }
  const keep = (
    clientMessageId: string,
    epoch: string,
    fields: Pick<JournalObservedSend, 'providerIdentity' | 'answeredTurnItemId'>
  ): void => {
    kept.set(clientMessageId, { ...kept.get(clientMessageId), clientMessageId, epoch, ...fields })
    const held = input.held()
    let over =
      kept.size + [...held].filter((id) => !kept.has(id)).length - MAX_CODEX_PENDING_DISPATCH_ECHOES
    for (const clientMessageId of kept.keys()) {
      if (over <= 0) {
        break
      }
      // Never a send Codex still holds: bookkeeping does not evict execution.
      if (!held.has(clientMessageId)) {
        kept.delete(clientMessageId)
        lose()
        over -= 1
      }
    }
  }
  return {
    receipt: (clientMessageId, identity) => {
      echoed = true
      const journal = input.journal()
      if (!journal?.submission || kept.get(clientMessageId)?.providerIdentity) {
        return
      }
      const submission = journal.submission(clientMessageId)
      if (!journalDispatchRowApplies(submission)) {
        loseUnsaved(identity, submission)
        return
      }
      // A send another generation was handed is a stale callback: unsaved, so lost here.
      if (submission?.handedOverAt === undefined || submission.fence !== input.fence) {
        lose()
        return
      }
      keep(clientMessageId, journal.epoch, { providerIdentity: identity })
    },
    saveReceipt: (clientMessageId, identity, armed) => {
      const observed = kept.get(clientMessageId)
      if (observed?.providerIdentity && !observed.receiptSaving) {
        observed.receiptSaving = true
        save({ sessionId: input.sessionId, clientMessageId, providerIdentity: identity })
      } else if (!input.journal()?.submission) {
        // No bound journal to check the send against (an unbound sink, or a test double): its armed
        // entry admits it, as it always has, and proves nothing about completeness.
        lose()
        if (armed) {
          save({ sessionId: input.sessionId, clientMessageId, providerIdentity: identity })
        }
      }
    },
    answer: (clientMessageId, turnId) => {
      const journal = input.journal()
      if (
        !journal?.submission?.(clientMessageId) ||
        journal.sendAnswer?.(clientMessageId) !== undefined ||
        kept.get(clientMessageId)?.answeredTurnItemId
      ) {
        return
      }
      const turnItemId = agentJournalItemKey(codexTurnLifecycleIdentity(input.sessionId, turnId))
      keep(clientMessageId, journal.epoch, { answeredTurnItemId: turnItemId })
      save({ sessionId: input.sessionId, clientMessageId, sendAnswered: { turnItemId } })
    },
    lose,
    noteFrame: (kind) => {
      if (CAPTURE_LOSS_FRAMES.has(kind)) {
        lose()
      }
    },
    certifies: () => echoed && !captureLost,
    retained: () => [...kept.values()].map(({ receiptSaving: _saving, ...observed }) => observed),
    prune,
    clear: () => {
      kept.clear()
      lose()
    }
  }
}

/** Whether every receipt `sends` holds is saved, or saves in the batch it rides: read against the
 *  fold where a turn's end executes, so a send rejected since its admission cannot certify it. */
export function codexReceiptsSaveable(
  journal: Pick<ObservationJournal, 'epoch' | 'submission'>,
  sends: readonly JournalObservedSend[]
): boolean {
  return sends.every(({ clientMessageId, epoch, providerIdentity }) => {
    if (!providerIdentity) {
      return true
    }
    const submission = epoch === journal.epoch ? journal.submission?.(clientMessageId) : undefined
    return submission?.dispatchState === 'accepted' || journalDispatchRowApplies(submission)
  })
}
