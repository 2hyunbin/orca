import { LegacyQueueDisplayCorrections } from './journal-legacy-display-corrections'
import { legacyQueuedChange } from './journal-legacy-queue-classification'
export { legacyQueuedChange } from './journal-legacy-queue-classification'
import { isDeepStrictEqual } from 'node:util'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
// Adopt legacy cards and delete their rows atomically, using the same fold before and after import.
// Retry failed bulk import on next open; do not loop while the host is running.

import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import type { QueuedMessageRow } from './queued-message-table'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'

type LegacyDeps = Pick<
  JournalQueuedMessagesDeps,
  'sessionId' | 'database' | 'state' | 'serialize' | 'readOnly' | 'writer' | 'committed'
>

export class LegacyQueuedCards {
  private revision = 0
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private owner?: JournalReducerState
  private loadedRevision = -1
  private viewRevision = 0
  private readonly originals = new Map<string, QueuedMessageRow>()
  private readonly classified = new Map<string, QueuedMessageRow>()
  private readonly display = new LegacyQueueDisplayCorrections()

  constructor(private readonly deps: LegacyDeps) {}

  private refresh(): void {
    const state = this.deps.state()
    if (this.owner !== state || this.loadedRevision !== this.revision) {
      for (const old of this.originals.values()) {
        state.selection.order.update('legacyPositions', old.messageId, undefined)
        state.selection.groups.update('unorderedLegacyPositions', old.messageId, false)
        this.register(state, old, false)
      }
      for (const old of this.classified.values()) {
        this.register(state, old, false)
      }
      this.originals.clear()
      this.classified.clear()
      this.display.clear()
      for (const row of this.rows()) {
        this.originals.set(row.messageId, row)
        this.register(state, row, true)
        state.selection.groups.update('dirtyLegacy', row.messageId, true)
      }
      this.owner = state
      this.loadedRevision = this.revision
      this.viewRevision++
    }
    for (;;) {
      const id = state.selection.groups.next('dirtyLegacy')?.key
      if (id === undefined) {
        break
      }
      state.selection.groups.update('dirtyLegacy', id, false)
      const original = this.originals.get(id)
      if (!original) {
        continue
      }
      const change = legacyQueuedChange(state, original)
      const card = change ? queuedCardFromChange(state, id, change) : undefined
      const old = this.classified.get(id)
      if (old) {
        this.register(state, old, false)
      }
      this.register(state, original, true)
      if (card) {
        this.register(state, card, true)
      }
      if (!isDeepStrictEqual(old, card)) {
        if (card) {
          this.classified.set(id, card)
        } else {
          this.classified.delete(id)
        }
        this.viewRevision++
      }
      state.selection.order.update(
        'legacyPositions',
        id,
        card ? { sequence: card.position, ordinal: 0 } : undefined
      )
      state.selection.groups.update(
        'unorderedLegacyPositions',
        id,
        card?.position !== undefined && card.position !== card.position
      )
      if (this.display.correct(state, id, card)) {
        this.viewRevision++
      }
    }
  }

  private register(state: JournalReducerState, row: QueuedMessageRow, present: boolean): void {
    if (row.state === 'waiting') {
      state.selection.groups.update(`legacyQueue:${row.messageId}`, row.messageId, present)
    }
    if (row.consumedAs !== null && row.state !== 'waiting') {
      state.selection.groups.update(`legacyRaw:${row.consumedAs}`, row.messageId, present)
      if (row.body.command) {
        const report = agentJournalItemKey(
          structuredAgentSessionCommandTurnIdentity(row.consumedAs)
        )
        state.selection.groups.update(`legacyReport:${report}`, row.messageId, present)
      }
    }
  }

  key(): string {
    this.refresh()
    return this.originals.size === 0 ? '' : `${this.revision}:${this.viewRevision}`
  }

  cards(): readonly QueuedMessageRow[] {
    this.refresh()
    return [...this.originals.keys()].flatMap((id) => {
      const card = this.classified.get(id)
      return card ? [card] : []
    })
  }

  get(messageId: string): QueuedMessageRow | undefined {
    this.refresh()
    return this.classified.get(messageId)
  }

  maximumPosition(): number {
    this.refresh()
    const selection = this.deps.state().selection
    return selection.groups.has('unorderedLegacyPositions')
      ? Number.NaN
      : Math.max(0, selection.order.maximum('legacyPositions')?.sequence ?? 0)
  }

  displayState(): JournalReducerState {
    this.refresh()
    return this.display.displayState(this.deps.state())
  }

  normalizationKey(): string {
    this.refresh()
    return this.display.normalizationKey(this.deps.state())
  }

  /** Resolve adoption on the write lane from current disk state; null means no legacy card. */
  adoption(messageId: string): JournalQueuedChange | null {
    if (this.key() === '') {
      return null
    }
    const { db } = this.deps.database()
    const row = db
      .prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`
      )
      .get(this.deps.sessionId, messageId)
    const card = row === undefined ? null : readStoredQueuedMessageRow(row)
    return card && legacyQueuedChange(this.deps.state(), card)
  }

  /** Delete in the caller's transaction and refresh the view after commit. */
  deletion(messageIds: readonly string[]): JournalOperationReceipt {
    return {
      write: (db) => {
        const remove = db.prepare(
          'DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?'
        )
        for (const messageId of messageIds) {
          remove.run(this.deps.sessionId, messageId)
        }
      },
      committed: () => {
        this.revision += messageIds.length > 0 ? 1 : 0
      }
    }
  }

  messageIds(): string[] {
    return this.rows().map((row) => row.messageId)
  }

  deletionOfAll(): JournalOperationReceipt {
    return this.deletion(this.messageIds())
  }

  /** Atomically adopt readable unanswered cards and delete legacy rows; failure leaves both unchanged. */
  importAtOpen(): Promise<void> {
    if (this.deps.readOnly() || this.rows().length === 0) {
      return Promise.resolve()
    }
    return this.deps
      .serialize(() => {
        const rows = this.read()
        const deletion = this.deletion(rows.map((row) => row.messageId))
        const plan = rows.flatMap((row) => {
          const change = legacyQueuedChange(this.deps.state(), row)
          return change ? [journalQueueRowBuilder(this.deps.state, row.messageId, change)] : []
        })
        if (plan.length > 0) {
          this.deps.writer.writeRows(() => plan, deletion)
          return
        }
        // Empty append plans open no transaction, so legacy deletion must commit independently.
        this.deps.database().transaction((db) => deletion.write(db))
        deletion.committed()
        this.deps.committed()
      })
      .catch((error: unknown) => {
        console.warn('[journal-open] queued-message import skipped:', {
          sessionId: this.deps.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  private rows(): readonly QueuedMessageRow[] {
    if (this.stored?.revision !== this.revision) {
      this.stored = { revision: this.revision, rows: this.read() }
    }
    return this.stored.rows
  }

  private read(): QueuedMessageRow[] {
    return this.deps
      .database()
      .db.prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
      )
      .all(this.deps.sessionId)
      .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
  }
}
