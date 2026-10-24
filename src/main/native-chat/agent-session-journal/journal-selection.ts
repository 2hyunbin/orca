import { legacyRawDependency, legacyAttemptDependency } from './journal-legacy-dependencies'
import {
  updateSelectedJournalItem,
  updateSelectedJournalAlias,
  updateSelectedTypedTurn
} from './journal-item-selection'
import { serialize } from 'node:v8'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { updateSelectedQueueCard, nextSelectedReportedCard } from './journal-queue-selection'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStructuralStorage } from './journal-rest-projection-index'
import { queuedHandOffOutcome } from './journal-dispatch-settlement'
import type { QueuedMessageRow } from './queued-message-table'
import { JournalSelectionStorage } from './journal-selection-storage'
import { JournalSelectionTree } from './journal-selection-tree'
import { JournalSelectionGroups } from './journal-selection-groups'
import { JournalSelectionOrder } from './journal-selection-order'

type SubmissionSource = {
  ordinal: number
  address: string
  fingerprint: string
  rank: number
  time: number
  queued?: string
  sequence: number
  inDoubt: boolean
  eligible: boolean
  signature: string
  rawSignature: string
  attemptSignature: string
}

/** Required derived endpoints, maintained at the original accepted source transitions. */
export class JournalSelection {
  readonly groups: JournalSelectionGroups
  readonly order: JournalSelectionOrder
  readonly tree: JournalSelectionTree
  readonly storage: JournalSelectionStorage
  private readonly sources: Map<string, SubmissionSource>
  private readonly counters: Map<string, number>
  private normalizationCache?: { epoch: string; revision: number; key: string }
  deferred = false

  constructor(disk?: JournalStructuralStorage, storage = new JournalSelectionStorage(disk)) {
    this.storage = storage
    this.groups = new JournalSelectionGroups(storage)
    this.tree = new JournalSelectionTree(storage)
    this.order = new JournalSelectionOrder(storage)
    this.sources = storage.map('submissionSources')
    this.counters = storage.map('counters')
  }

  fork(): JournalSelection {
    return new JournalSelection(undefined, this.storage.fork())
  }

  checkpoint(): { format: 6 } {
    return { format: 6 }
  }

  nextOrdinal(name: string): number {
    const next = (this.counters.get(name) ?? 0) + 1
    this.counters.set(name, next)
    return next
  }

  rawAt(address: string): string | undefined {
    return this.groups.next(`address:${address}`)?.key
  }

  contextFloor(): number {
    return Math.max(0, this.order.maximum('itemClears')?.sequence ?? 0)
  }

  echo(fingerprint: string): string | undefined {
    const floor = this.contextFloor()
    return this.tree.minimum(`echo:${fingerprint}`, floor === 0 ? undefined : floor)?.key
  }

  invalidate(group: string): void {
    for (const card of this.groups.values(group)) {
      this.groups.update('dirtyLegacy', card, true)
    }
  }

  private refreshEcho(raw: string, state: JournalReducerState): void {
    const previous = this.sources.get(raw)
    const value = state.submissions.get(raw)
    if (!value) {
      return
    }
    const eligible =
      value.dispatchState !== 'rejected' &&
      !isWriteFailureSubmission(value) &&
      state.items.get(agentJournalSubmissionKey(raw))?.revision === 0
    if (previous?.eligible === eligible) {
      return
    }
    const next = { ...previous!, eligible }
    this.sources.set(raw, next)
    this.tree.update(
      `echo:${value.payloadFingerprint}`,
      raw,
      eligible
        ? {
            key: raw,
            rank: next.rank,
            ordinal: next.ordinal,
            time: next.time
          }
        : undefined
    )
  }

  private refreshLegacyRaw(raw: string, state: JournalReducerState): void {
    const previous = this.sources.get(raw)
    if (!previous) {
      return
    }
    const rawSignature = legacyRawDependency(raw, state.submissions.get(raw), state)
    if (previous.rawSignature !== rawSignature) {
      this.sources.set(raw, { ...previous, rawSignature })
      this.invalidate(`legacyRaw:${raw}`)
    }
  }

  submissionChanged(
    raw: string,
    value: AgentJournalSubmission | undefined,
    state: JournalReducerState
  ): void {
    const old = this.sources.get(raw)
    const ordinal = old?.ordinal ?? this.nextOrdinal('submissions')
    const signature = value === undefined ? '' : serialize(value).toString('base64')
    const rawSignature = legacyRawDependency(raw, value, state)
    const attemptSignature = legacyAttemptDependency(value)
    const attemptChanged = old?.attemptSignature !== attemptSignature
    const orderChanged =
      old?.queued !== value?.queuedMessageId || old?.sequence !== (value?.submittedSequence ?? 0)
    if (old?.signature === signature) {
      return
    }
    if (old) {
      this.tree.update(`echo:${old.fingerprint}`, raw, undefined)
      if (!value) {
        this.groups.update(`address:${old.address}`, raw, false)
      }
      if (old.queued !== undefined && orderChanged) {
        this.order.update(`attempt:${old.queued}`, raw, undefined, true)
      }
      if (old.queued !== undefined && attemptChanged) {
        this.groups.update(`doubt:${old.queued}`, raw, false)
        this.groups.touch(`attempt:${old.queued}`)
        this.invalidate(`legacyQueue:${old.queued}`)
      }
    }
    if (!value) {
      this.sources.delete(raw)
    } else {
      const address = agentJournalSubmissionKey(raw)
      const eligible =
        value.dispatchState !== 'rejected' &&
        !isWriteFailureSubmission(value) &&
        state.items.get(address)?.revision === 0
      const next: SubmissionSource = {
        ordinal,
        address,
        fingerprint: value.payloadFingerprint,
        rank: value.acceptedSequence ?? 0,
        time: value.submittedAt,
        sequence: value.submittedSequence ?? 0,
        queued: value.queuedMessageId,
        inDoubt: value.dispatchState === 'rejected' && queuedHandOffOutcome(value) === 'inDoubt',
        eligible,
        signature,
        rawSignature,
        attemptSignature
      }
      this.sources.set(raw, next)
      this.groups.update(`address:${address}`, raw, true, ordinal)
      if (eligible) {
        this.tree.update(`echo:${next.fingerprint}`, raw, {
          key: raw,
          rank: next.rank,
          ordinal,
          time: next.time
        })
      }
      if (next.queued !== undefined && orderChanged) {
        this.order.update(`attempt:${next.queued}`, raw, { sequence: next.sequence, ordinal }, true)
      }
      if (next.queued !== undefined && attemptChanged) {
        this.groups.update(`doubt:${next.queued}`, raw, next.inDoubt, ordinal)
        this.groups.touch(`attempt:${next.queued}`)
        this.invalidate(`legacyQueue:${next.queued}`)
      }
    }
    if (old?.rawSignature !== rawSignature) {
      this.invalidate(`legacyRaw:${raw}`)
    }
    this.normalizationChanged(raw, state)
  }

  itemChanged(
    id: string,
    value: AgentJournalRenderItem | undefined,
    previous: AgentJournalRenderItem | undefined,
    state: JournalReducerState
  ): void {
    updateSelectedJournalItem(this, id, value, previous, state)
  }

  refreshStep(state: JournalReducerState): boolean {
    const pending = this.storage.map<
      string,
      { address: string; alias?: true; cursor?: ReturnType<JournalSelectionGroups['next']> }
    >('sourcePending')
    let task = pending.get('echo')
    if (!task) {
      const alias = this.groups.next('refreshAliases')?.key
      const address = alias ?? this.groups.next('refreshEchoAddresses')?.key
      if (address === undefined) {
        return false
      }
      task = { address, ...(alias !== undefined ? { alias: true as const } : {}) }
    }
    const next = this.groups.next(
      `${task.alias ? 'aliasUsers' : 'address'}:${task.address}`,
      task.cursor
    )
    if (!next) {
      this.groups.update(
        task.alias ? 'refreshAliases' : 'refreshEchoAddresses',
        task.address,
        false
      )
      pending.delete('echo')
    } else {
      if (task.alias) {
        this.groups.update('aliasRestDirty', next.key, true)
        updateSelectedTypedTurn(this, next.key, state.items.get(next.key), state, true)
      } else {
        this.refreshEcho(next.key, state)
        this.normalizationChanged(next.key, state)
        this.refreshLegacyRaw(next.key, state)
      }
      pending.set('echo', { ...task, cursor: next })
    }
    return true
  }

  aliasChanged(
    alias: string,
    target: string | undefined,
    previous: string | undefined,
    state: JournalReducerState
  ): void {
    updateSelectedJournalAlias(this, alias, target, previous, state)
  }

  cardChanged(
    id: string,
    card: QueuedMessageRow | undefined,
    previous: QueuedMessageRow | undefined,
    state: JournalReducerState
  ): void {
    updateSelectedQueueCard(this, state, id, card, previous)
  }

  nextReportedCard(state: JournalReducerState): string | undefined {
    return nextSelectedReportedCard(this, state)
  }

  normalizationChanged(raw: string, state: JournalReducerState): void {
    const signatures = this.storage.map<string, string>('normalizationSources')
    const item = state.items.get(agentJournalSubmissionKey(raw))
    const submission = state.submissions.get(raw)
    const next =
      state.normalizedHandOffs.has(raw) && item && submission
        ? JSON.stringify([
            raw,
            item.sequence,
            item.observedAt,
            item.turnScope,
            submission.queuedMessageId ?? null
          ])
        : undefined
    if (signatures.get(raw) === next) {
      return
    }
    if (next === undefined) {
      signatures.delete(raw)
    } else {
      signatures.set(raw, next)
    }
    this.nextOrdinal('normalizationRevision')
  }

  normalizationRevision(): number {
    return this.counters.get('normalizationRevision') ?? 0
  }

  normalizationEntries(): ReadonlyMap<string, string> {
    return this.storage.map('normalizationSources')
  }

  normalizationKey(epoch: string): string {
    const revision = this.counters.get('normalizationRevision') ?? 0
    const old = this.normalizationCache
    if (old?.epoch === epoch && old.revision === revision) {
      return old.key
    }
    const signatures = this.storage.map<string, string>('normalizationSources')
    const rows = [...signatures]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => JSON.parse(value))
    const key = rows.length ? JSON.stringify([epoch, rows]) : ''
    this.normalizationCache = { epoch, revision, key }
    return key
  }
}
