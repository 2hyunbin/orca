// What this child's Codex said about sends, kept from the moment it is read until the journal
// shows it saved: the exact echo that is a send's receipt, and the turn a successful answer named.
// Each is saved at once and nonfatally; whatever the fold still lacks rides the turn's terminal
// append and the host's exit settlement, so a failed save never stops the reply. The fold is the
// only thing that clears a kept observation. Bounded together with the sends Codex holds: a new
// send always wins, so overflow drops the oldest kept observation, and the turn it named can no
// longer certify that its receipts are complete.

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

type Kept = JournalObservedSend & { turnId: string | null; receiptSaving?: true }

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
  /** Capture lost something of this turn, or of an unplaceable one. */
  lose: (turnId: string | null) => void
  /** A frame the connection could not deliver. */
  noteFrame: (kind: string) => void
  /** Whether this generation's capture of the turn's receipts is whole. */
  certifies: (turnId: string) => boolean
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
  const lostTurns = new Set<string>()
  let lostUnplaced = false
  let echoed = false
  const lose = (turnId: string | null): void => {
    if (
      turnId !== null &&
      (lostTurns.has(turnId) || lostTurns.size < MAX_CODEX_PENDING_DISPATCH_ECHOES)
    ) {
      lostTurns.add(turnId)
    } else {
      lostUnplaced = true
    }
  }
  // A receipt the journal neither holds nor can still take leaves its turn unproven.
  const loseUnsaved = (
    identity: AgentJournalItemIdentity | undefined,
    submission: AgentJournalSubmission | undefined
  ): void => {
    if (identity && submission?.dispatchState !== 'accepted') {
      lose(codexTurnOf(identity))
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
    turnId: string | null,
    fields: Pick<JournalObservedSend, 'providerIdentity' | 'answeredTurnItemId'>
  ): void => {
    const existing = kept.get(clientMessageId)
    kept.set(clientMessageId, {
      ...existing,
      clientMessageId,
      epoch,
      turnId: existing?.turnId ?? turnId,
      ...fields
    })
    const held = input.held()
    let over =
      kept.size + [...held].filter((id) => !kept.has(id)).length - MAX_CODEX_PENDING_DISPATCH_ECHOES
    for (const [clientMessageId, observed] of kept) {
      if (over <= 0) {
        break
      }
      // Never a send Codex still holds: bookkeeping does not evict execution.
      if (!held.has(clientMessageId)) {
        kept.delete(clientMessageId)
        lose(observed.turnId)
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
      // A send another generation was handed is a stale callback: unsaved, so its turn is unproven.
      if (submission?.handedOverAt === undefined || submission.fence !== input.fence) {
        lose(codexTurnOf(identity))
        return
      }
      keep(clientMessageId, journal.epoch, codexTurnOf(identity), { providerIdentity: identity })
    },
    saveReceipt: (clientMessageId, identity, armed) => {
      const observed = kept.get(clientMessageId)
      if (observed?.providerIdentity && !observed.receiptSaving) {
        observed.receiptSaving = true
        save({ sessionId: input.sessionId, clientMessageId, providerIdentity: identity })
      } else if (!input.journal()?.submission) {
        // No bound journal to check the send against (an unbound sink, or a test double): its armed
        // entry admits it, as it always has, and proves nothing about the turn.
        lose(codexTurnOf(identity))
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
      keep(clientMessageId, journal.epoch, turnId, { answeredTurnItemId: turnItemId })
      save({ sessionId: input.sessionId, clientMessageId, sendAnswered: { turnItemId } })
    },
    lose,
    noteFrame: (kind) => {
      if (CAPTURE_LOSS_FRAMES.has(kind)) {
        lose(null)
      }
    },
    certifies: (turnId) => echoed && !lostUnplaced && !lostTurns.has(turnId),
    retained: () =>
      [...kept.values()].map(
        ({ turnId: _turnId, receiptSaving: _saving, ...observed }) => observed
      ),
    prune,
    clear: () => {
      kept.clear()
      lostUnplaced = true
    }
  }
}

/** Whether every receipt `sends` holds for `turnId` is saved, or saves in the batch it rides: read
 *  against the fold where that turn's end executes, so a send rejected since its admission cannot
 *  certify it. */
export function codexTurnReceiptsSaveable(
  journal: Pick<ObservationJournal, 'epoch' | 'submission'>,
  sends: readonly JournalObservedSend[],
  turnId: string
): boolean {
  return sends.every(({ clientMessageId, epoch, providerIdentity }) => {
    if (!providerIdentity || codexTurnOf(providerIdentity) !== turnId) {
      return true
    }
    const submission = epoch === journal.epoch ? journal.submission?.(clientMessageId) : undefined
    return submission?.dispatchState === 'accepted' || journalDispatchRowApplies(submission)
  })
}

function codexTurnOf(identity: AgentJournalItemIdentity): string | null {
  return identity.provider === 'codex' ? identity.turnId : null
}
