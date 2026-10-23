import type { JournalRowBase, JournalItemRow, JournalLifecycleBatchRow } from './journal-row-schema'

export type JournalTextDeltaRow = Omit<JournalItemRow, 'kind' | 'body'> & {
  kind: 'text-delta'
  field: number
  predecessor: number
  baseLength: number
  suffix: string
}

export type JournalSequenceRange = readonly [number, number]

export type JournalTextPrunedRow = JournalRowBase & {
  kind: 'text-pruned'
  itemId: string
  field: number
  marker: number
  witness: number
  revision: number
  ranges: JournalSequenceRange[]
}

/** Host-only admission: the whole value is materialized only for an anchor or replacement. */
export type JournalTextAdmission = {
  field: number
  baseLength: number
  suffix: string
  text: () => string
  replace?: true
}

export function journalWholeItem(
  row: JournalItemRow | JournalLifecycleBatchRow,
  itemId: string,
  revision?: number
) {
  const item =
    row.kind === 'item'
      ? row
      : row.mutations.find(
          (mutation) =>
            mutation.kind === 'item' &&
            mutation.itemId === itemId &&
            (revision === undefined || mutation.revision === revision)
        )
  return item?.kind === 'item' &&
    item.itemId === itemId &&
    (revision === undefined || item.revision === revision)
    ? item
    : undefined
}

export function journalTextField(body: JournalItemRow['body'], field: number): string | null {
  const block = body.kind === 'message' ? body.blocks[field] : undefined
  return block?.type === 'text' ? block.text : null
}

export function journalTextFields(body: JournalItemRow['body']): number[] {
  return body.kind === 'message' && (body.role === 'assistant' || body.role === 'reasoning')
    ? body.blocks.flatMap((block, index) => (block.type === 'text' ? [index] : []))
    : []
}

export function withJournalText(body: JournalItemRow['body'], field: number, text: string) {
  if (body.kind !== 'message' || body.blocks[field]?.type !== 'text') {
    throw new Error('journal_text_field_missing')
  }
  return {
    ...body,
    blocks: body.blocks.map((block, index) =>
      index === field ? { type: 'text' as const, text } : block
    )
  }
}

export function journalTextRowContent(record: Record<string, unknown>): boolean {
  return (
    typeof record.itemId === 'string' &&
    record.itemId.length > 0 &&
    Number.isSafeInteger(record.field) &&
    Number(record.field) >= 0 &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) > 0 &&
    (record.kind === 'text-delta'
      ? Number.isSafeInteger(record.predecessor) &&
        Number(record.predecessor) > 0 &&
        Number(record.predecessor) < Number(record.revision) &&
        Number.isSafeInteger(record.baseLength) &&
        Number(record.baseLength) >= 0 &&
        typeof record.suffix === 'string' &&
        record.suffix.length > 0
      : Number.isSafeInteger(record.marker) &&
        Number(record.marker) > 0 &&
        Number.isSafeInteger(record.witness) &&
        Number(record.witness) > Number(record.marker) &&
        Number(record.witness) < Number(record.seq) &&
        Array.isArray(record.ranges) &&
        record.ranges.length > 0 &&
        record.ranges.length <= 128 &&
        record.ranges.every(
          (range) =>
            Array.isArray(range) &&
            range.length === 2 &&
            Number.isSafeInteger(range[0]) &&
            Number.isSafeInteger(range[1]) &&
            range[0] > Number(record.marker) &&
            range[0] <= range[1] &&
            range[1] < Number(record.witness)
        ))
  )
}
