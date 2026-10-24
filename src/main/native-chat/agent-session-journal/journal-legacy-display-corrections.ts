import { isDeepStrictEqual } from 'node:util'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { JournalDisplayOverlay, JournalDisplaySet } from './journal-display-overlay'
import { stageJournalMutation } from './journal-mutation-stage'
import { handOffInDoubt } from './journal-legacy-queue-classification'
import { foldQueuedHandOffInDoubt } from './journal-submission-fold'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'

type DisplayCorrection = {
  item?: AgentJournalRenderItem
  submission: AgentJournalSubmission
}

export class LegacyQueueDisplayCorrections {
  private readonly corrections = new Map<string, DisplayCorrection>()
  private readonly correctionOwners = new Map<string, Map<string, DisplayCorrection>>()
  private readonly itemCorrections = new Map<string, AgentJournalRenderItem>()
  private readonly submissionCorrections = new Map<string, AgentJournalSubmission>()
  private normalization?: {
    owner: JournalReducerState
    epoch: string
    rawRevision: number
    key: string
  }

  clear(): void {
    this.normalization = undefined
    this.corrections.clear()
    this.correctionOwners.clear()
    this.itemCorrections.clear()
    this.submissionCorrections.clear()
  }

  correct(state: JournalReducerState, id: string, card: QueuedMessageRow | undefined): boolean {
    const raw = card?.consumedAs
    const submission = raw === null || raw === undefined ? undefined : state.submissions.get(raw)
    const old = this.corrections.get(id)
    let correction: DisplayCorrection | undefined
    if (submission && handOffInDoubt(submission)) {
      const display = stageJournalMutation(state, [])
      const copy = { ...submission }
      display.submissions.set(copy.clientMessageId, copy)
      foldQueuedHandOffInDoubt(display, copy)
      correction = {
        item: display.items.get(agentJournalSubmissionKey(submission.clientMessageId)),
        submission: display.submissions.get(submission.clientMessageId)!
      }
    }
    if (isDeepStrictEqual(old, correction)) {
      return false
    }
    if (old) {
      this.correctionOwners.get(old.submission.clientMessageId)?.delete(id)
    }
    if (correction) {
      this.corrections.set(id, correction)
      const raw = correction.submission.clientMessageId
      let owners = this.correctionOwners.get(raw)
      if (!owners) {
        owners = new Map()
        this.correctionOwners.set(raw, owners)
      }
      owners.set(id, correction)
    } else {
      this.corrections.delete(id)
    }
    const normalizationOf = (raw: string): string | undefined => {
      const submission = this.submissionCorrections.get(raw)
      if (!submission) {
        return state.selection.normalizationEntries().get(raw)
      }
      const item =
        this.itemCorrections.get(agentJournalSubmissionKey(raw)) ??
        state.items.get(agentJournalSubmissionKey(raw))
      return (
        item &&
        JSON.stringify([
          raw,
          item.sequence,
          item.observedAt,
          item.turnScope,
          submission.queuedMessageId ?? null
        ])
      )
    }
    const refresh = (raw: string) => {
      const before = normalizationOf(raw)
      const owner = this.correctionOwners.get(raw)?.values().next().value
      if (owner) {
        if (owner.item) {
          this.itemCorrections.set(agentJournalSubmissionKey(raw), owner.item)
        } else {
          this.itemCorrections.delete(agentJournalSubmissionKey(raw))
        }
        this.submissionCorrections.set(raw, owner.submission)
      } else {
        this.correctionOwners.delete(raw)
        this.itemCorrections.delete(agentJournalSubmissionKey(raw))
        this.submissionCorrections.delete(raw)
      }
      if (before !== normalizationOf(raw)) {
        this.normalization = undefined
      }
    }
    if (old) {
      refresh(old.submission.clientMessageId)
    }
    if (correction) {
      refresh(correction.submission.clientMessageId)
    }
    return true
  }

  displayState(state: JournalReducerState): JournalReducerState {
    if (this.submissionCorrections.size === 0) {
      return state
    }
    const normalized = new JournalDisplaySet(state.normalizedHandOffs, this.submissionCorrections)
    return {
      ...state,
      normalizedHandOffs: normalized,
      items: new JournalDisplayOverlay(state.items, this.itemCorrections),
      submissions: new JournalDisplayOverlay(state.submissions, this.submissionCorrections)
    }
  }

  normalizationKey(state: JournalReducerState): string {
    const rawRevision = state.selection.normalizationRevision()
    const cached = this.normalization
    if (
      cached?.owner === state &&
      cached.epoch === state.epoch &&
      cached.rawRevision === rawRevision
    ) {
      return cached.key
    }
    const entries = new Map(state.selection.normalizationEntries())
    for (const [raw, submission] of this.submissionCorrections) {
      const item =
        this.itemCorrections.get(agentJournalSubmissionKey(raw)) ??
        state.items.get(agentJournalSubmissionKey(raw))
      if (item) {
        entries.set(
          raw,
          JSON.stringify([
            raw,
            item.sequence,
            item.observedAt,
            item.turnScope,
            submission.queuedMessageId ?? null
          ])
        )
      }
    }
    const values = [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => JSON.parse(value))
    const key = values.length ? JSON.stringify([state.epoch, values]) : ''
    this.normalization = { owner: state, epoch: state.epoch, rawRevision, key }
    return key
  }
}
