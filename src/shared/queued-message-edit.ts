import type { AgentJournalMessageItem } from './agent-session-journal-types'
import { MAX_BLOCKS, MAX_PROMPT_BYTES } from './rpc-contract/structured-agent-session-params'

export type QueuedMessageImageBlock = Extract<
  AgentJournalMessageItem['blocks'][number],
  { type: 'image-ref' }
>

/** What Save writes: the text, and when `images` is given, the complete ordered image set. */
export type QueuedMessageEdit = { text: string; images?: readonly QueuedMessageImageBlock[] }

export type QueuedMessageEditResult =
  | { ok: true; body: AgentJournalMessageItem }
  | { ok: false; reason: 'not-editable' | 'empty' | 'too-large' | 'too-many-blocks' }

/** The text an in-place edit starts from, or null when the card is not editable: a command is
 *  not a draft, and a block this edit cannot carry over unchanged refuses rather than drops. */
export function queuedMessageEditableText(body: AgentJournalMessageItem): string | null {
  if (body.command || body.blocks.some((b) => b.type !== 'text' && b.type !== 'image-ref')) {
    return null
  }
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function imageBlocks(body: AgentJournalMessageItem): QueuedMessageImageBlock[] {
  return body.blocks.filter((block): block is QueuedMessageImageBlock => block.type === 'image-ref')
}

function sameImages(
  a: readonly QueuedMessageImageBlock[],
  b: readonly QueuedMessageImageBlock[]
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.path === b[i]?.path && x.url === b[i]?.url && x.alt === b[i]?.alt)
  )
}

/** The edited body; sender, kind and send mode stay. Without `images` the text replaces the
 *  first text block in place and attachments stay; with them the blocks are rebuilt in a fresh
 *  send's order (text, then images), within the limits `SendBody` enforces. */
export function queuedMessageWithEdit(
  body: AgentJournalMessageItem,
  edit: QueuedMessageEdit
): QueuedMessageEditResult {
  const { text, images } = edit
  const editable = queuedMessageEditableText(body)
  if (editable === null) {
    return { ok: false, reason: 'not-editable' }
  }
  if (byteLength(text) > MAX_PROMPT_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  if (!text.trim() && (images ? images.length === 0 : imageBlocks(body).length === 0)) {
    return { ok: false, reason: 'empty' }
  }
  // Unchanged text and images keep their blocks, so a Save that changes nothing is a no-op.
  if (text === editable && (!images || sameImages(images, imageBlocks(body)))) {
    return { ok: true, body }
  }
  if (images) {
    const blocks: AgentJournalMessageItem['blocks'] = [
      ...(text.trim() ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...images
    ]
    if (blocks.length > MAX_BLOCKS) {
      return { ok: false, reason: 'too-many-blocks' }
    }
    if (byteLength(JSON.stringify(blocks)) > MAX_PROMPT_BYTES) {
      return { ok: false, reason: 'too-large' }
    }
    return { ok: true, body: { ...body, blocks } }
  }
  const blocks: AgentJournalMessageItem['blocks'] = []
  let placed = false
  for (const block of body.blocks) {
    if (block.type !== 'text') {
      blocks.push(block)
    } else if (!placed) {
      blocks.push({ type: 'text', text })
      placed = true
    }
  }
  if (!placed) {
    blocks.unshift({ type: 'text', text })
  }
  return { ok: true, body: { ...body, blocks } }
}
