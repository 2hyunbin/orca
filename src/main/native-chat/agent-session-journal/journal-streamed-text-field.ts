import type { JournalRow } from './journal-row-schema'

export type JournalTextPath = 'message' | 'tool-output' | 'diff-patch' | 'status'
export type JournalStreamedText = { path: JournalTextPath; text: string }

export function journalStreamedText(row: JournalRow): JournalStreamedText | null {
  if (row.kind !== 'item') {
    return null
  }
  const body = row.body
  if (body.kind === 'message' && body.role !== 'user' && body.blocks.length === 1) {
    const block = body.blocks[0]
    if (block?.type === 'text' && typeof block.text === 'string') {
      return { path: 'message', text: block.text }
    }
  }
  if (body.kind === 'tool-call' && body.output && typeof body.output.head === 'string') {
    return { path: 'tool-output', text: body.output.head }
  }
  if (body.kind === 'diff' && typeof body.patch.head === 'string') {
    return { path: 'diff-patch', text: body.patch.head }
  }
  if (body.kind === 'status' && body.failure === undefined && typeof body.text === 'string' &&
      body.turnLifecycle === undefined && body.threadGoal === undefined &&
      body.contextClear === undefined && body.orcaStop === undefined && body.providerFrame === undefined) {
    return { path: 'status', text: body.text }
  }
  return null
}

export function replaceJournalStreamedText(row: JournalRow, path: string, text: string): JournalRow | null {
  if (row.kind !== 'item') {
    return null
  }
  const body = row.body
  if (path === 'message' && body.kind === 'message' && body.role !== 'user' && body.blocks.length === 1) {
    const block = body.blocks[0]
    if (block?.type === 'text') {
      return { ...row, body: { ...body, blocks: [{ ...block, text }] } }
    }
  }
  if (path === 'tool-output' && body.kind === 'tool-call' && body.output) {
    return { ...row, body: { ...body, output: { ...body.output, head: text } } }
  }
  if (path === 'diff-patch' && body.kind === 'diff') {
    return { ...row, body: { ...body, patch: { ...body.patch, head: text } } }
  }
  if (
    path === 'status' &&
    body.kind === 'status' &&
    body.failure === undefined &&
    journalStreamedText(row)?.path === 'status'
  ) {
    return { ...row, body: { ...body, text } }
  }
  return null
}

/** ASCII fragments preserve each UTF-16 unit, including lone surrogates, through SQLite. */
export function escapeJournalText(text: string): string {
  return JSON.stringify(text).slice(1, -1).replace(/[\u007f-\uffff]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

export function journalTextCommonPrefix(left: string, right: string): number {
  const end = Math.min(left.length, right.length)
  let index = 0
  while (index < end && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1
  }
  return index
}
