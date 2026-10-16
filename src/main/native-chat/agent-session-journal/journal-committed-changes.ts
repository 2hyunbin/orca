import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

export function journalPublication(changes: JournalCommittedChanges, state: JournalReducerState) {
  const snapshot = renderJournalState(state)
  const aliases = new Map(state.aliases)
  return {
    snapshot,
    rowsAfter: changes.capture(snapshot.cursor),
    canonicalItemId: (itemId: string) => aliases.get(itemId) ?? itemId
  }
}

export type JournalProjectionRow =
  | Pick<Extract<JournalRow, { kind: 'epoch' }>, 'kind' | 'seq'>
  | Pick<Extract<JournalRow, { kind: 'item' }>, 'kind' | 'seq' | 'itemId'>
  | (Pick<Extract<JournalRow, { kind: 'tombstone' }>, 'kind' | 'seq' | 'itemId'> & {
      stopEvent?: unknown
      queueResume?: unknown
      queueReopen?: unknown
      queueClear?: unknown
    })
  | Pick<Extract<JournalRow, { kind: 'submission' | 'dispatch' }>, 'kind' | 'seq' | 'clientMessageId'>
  | { kind: 'lifecycle-batch'; seq: number; mutations: readonly { itemId: string }[] }

const MAX_BYTES = 64 * 1024
const MAX_ROWS = AGENT_SESSION_HISTORY_MAX_LIMIT + 1

function compact(row: JournalRow): { row: JournalProjectionRow; bytes: number } | null {
  const base = { kind: row.kind, seq: row.seq }
  if (row.kind === 'lifecycle-batch') {
    let bytes = 128
    for (const mutation of row.mutations) {
      bytes += 64 + 2 * mutation.itemId.length
      if (bytes > MAX_BYTES) return null
    }
    return { row: { ...base, kind: row.kind,
      mutations: row.mutations.map(({ itemId }) => ({ itemId })) }, bytes }
  }
  if (isJournalStopOrResumeRow(row)) {
    // All four queue marks advance the cursor without removing their synthetic item ids.
    return { row: { ...base, kind: 'tombstone', itemId: '', stopEvent: true }, bytes: 128 }
  }
  if (row.kind === 'item' || row.kind === 'tombstone') {
    const bytes = 128 + 2 * row.itemId.length
    return bytes > MAX_BYTES ? null : { row: { ...base, kind: row.kind, itemId: row.itemId }, bytes }
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    const bytes = 128 + 2 * row.clientMessageId.length
    return bytes > MAX_BYTES ? null : {
      row: { ...base, kind: row.kind, clientMessageId: row.clientMessageId }, bytes }
  }
  return { row: { kind: 'epoch', seq: row.seq }, bytes: 128 }
}

/** A bounded suffix of committed identifiers; saved reads remain the fallback outside it. */
export class JournalCommittedChanges {
  private entries: { row: JournalProjectionRow; bytes: number }[] = []
  private bytes = 0

  clear(): void {
    this.entries = []
    this.bytes = 0
  }

  append(rows: readonly JournalRow[]): void {
    for (const row of rows) {
      const entry = compact(row)
      if (!entry) {
        this.clear()
        continue
      }
      this.entries.push(entry)
      this.bytes += entry.bytes
      while (this.entries.length > MAX_ROWS || this.bytes > MAX_BYTES) {
        this.bytes -= this.entries.shift()!.bytes
      }
    }
  }

  capture(head: AgentJournalCursor): (cursor: AgentJournalCursor, limit: number) =>
    readonly JournalProjectionRow[] | undefined {
    const rows = this.entries.map((entry) => entry.row)
    return (cursor, limit) => {
      if (cursor.epoch !== head.epoch || cursor.sequence > head.sequence ||
          cursor.sequence < (rows[0]?.seq ?? head.sequence + 1) - 1) return undefined
      return rows.filter((row) => row.seq > cursor.sequence).slice(0, limit)
    }
  }
}
