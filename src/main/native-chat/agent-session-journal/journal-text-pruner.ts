import type { JournalStoreHost } from './journal-store-collaborators'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalRow } from './journal-row-schema'
import { readJournalTextRow, validateJournalTextProof } from './journal-text-index'
import type { JournalSequenceRange, JournalTextPrunedRow } from './journal-text-rows'

/** One bounded unit per queue turn; failure retains the pieces and stops this drain. */
export class JournalTextPruner {
  private scheduled: ReturnType<typeof setImmediate> | null = null
  private closed = false

  constructor(
    private readonly host: JournalStoreHost,
    private readonly writer: JournalRowWriter
  ) {}

  committed(rows: readonly JournalRow[]): void {
    if (rows.some((row) => row.kind === 'item' || row.kind === 'lifecycle-batch')) {
      if (this.attempt()) {
        this.schedule()
      }
    }
  }

  schedule(): void {
    if (
      this.closed ||
      this.scheduled ||
      this.host.readOnly() ||
      !this.host.state().textIndex.ready.size
    ) {
      return
    }
    const epoch = this.host.state().epoch
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this.closed || this.host.state().epoch !== epoch) {
        return
      }
      void this.host
        .serialize(() => this.attempt())
        .then(
          (ok) => {
            if (ok) {
              this.schedule()
            }
          },
          (error: unknown) => this.failed(error)
        )
    })
    this.scheduled.unref()
  }

  close(): void {
    this.closed = true
    if (this.scheduled) {
      clearImmediate(this.scheduled)
    }
    this.scheduled = null
  }

  private attempt(): boolean {
    if (this.closed || this.host.readOnly()) {
      return false
    }
    try {
      this.pruneOne()
      return true
    } catch (error) {
      if (this.scheduled) {
        clearImmediate(this.scheduled)
      }
      this.scheduled = null
      this.failed(error)
      return false
    }
  }

  private failed(error: unknown): void {
    console.warn('[journal-text-prune] keeping saved text pieces:', {
      sessionId: this.host.identity.sessionId,
      error
    })
  }

  private pruneOne(): void {
    const state = this.host.state()
    const key = state.textIndex.ready.values().next().value
    if (key === undefined) {
      return
    }
    const piece = state.textIndex.pieces.get(key)
    if (!piece) {
      return
    }
    const protectedRows = new Set(state.providerActivityWitness.values())
    const sequences: number[] = []
    const ranges: JournalSequenceRange[] = []
    for (const [first, last] of piece.ranges) {
      for (let seq = first; seq <= Math.min(last, piece.witness - 1); seq++) {
        if (protectedRows.has(seq)) {
          continue
        }
        const previous = ranges.at(-1)
        if (previous && previous[1] + 1 === seq) {
          ranges[ranges.length - 1] = [previous[0], seq]
        } else {
          if (ranges.length >= 128) {
            break
          }
          ranges.push([seq, seq])
        }
        sequences.push(seq)
        if (sequences.length >= 256) {
          break
        }
      }
      if (sequences.length >= 256 || ranges.length >= 128) {
        break
      }
    }
    if (!sequences.length) {
      state.textIndex.reconsider(key, protectedRows)
      return
    }
    const sessionId = this.host.identity.sessionId
    this.writer.writeRows(
      () => [
        (seq, ts): JournalTextPrunedRow => ({
          kind: 'text-pruned',
          v: 5,
          epoch: state.epoch,
          seq,
          ts,
          fence: state.highestFence,
          itemId: piece.itemId,
          field: piece.field,
          marker: piece.marker,
          witness: piece.witness,
          revision: piece.revision,
          ranges
        })
      ],
      {
        write: (db, row) => {
          if (
            !row ||
            row.kind !== 'text-pruned' ||
            !validateJournalTextProof(db, sessionId, row, false)
          ) {
            throw new Error('journal_text_prune_witness_invalid')
          }
          for (const seq of sequences) {
            const target = readJournalTextRow(db, sessionId, state.epoch, seq)
            if (
              !target ||
              target.kind !== 'text-delta' ||
              target.itemId !== piece.itemId ||
              target.field !== piece.field ||
              target.revision >= piece.revision ||
              protectedRows.has(seq)
            ) {
              throw new Error('journal_text_prune_target_invalid')
            }
          }
          const remove = db.prepare(
            'DELETE FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq BETWEEN ? AND ?'
          )
          for (const [first, last] of ranges) {
            remove.run(sessionId, state.epoch, first, last)
          }
        },
        committed: () => undefined
      },
      (rows) => rows[0]
    )
  }
}
