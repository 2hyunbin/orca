import { ownRetainedString } from '../../../../shared/own-retained-string'

/** Lines of one text output that are drawn; earlier lines stay in the notebook and are saved. */
export const DRAWN_OUTPUT_LINES = 5000
/** UTF-16 units drawn when the last lines are very long, e.g. one line with no breaks. */
export const DRAWN_OUTPUT_CHARS = 1024 * 1024
/** Outputs drawn per cell; the rest stay in the notebook and are saved. */
export const DRAWN_OUTPUTS_PER_CELL = 500

/** The end of an output's text that is drawn, and whether earlier text was left out. */
export type DrawnText = { text: string; truncated: boolean; blocks?: readonly DrawnBlock[] }
export type DrawnBlock = { id: number; text: string; newlines: readonly number[] }

let nextBlockId = 1

export function drawnBlock(text: string, id = nextBlockId++): DrawnBlock {
  const newlines: number[] = []
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    newlines.push(index)
  }
  return { id, text: ownRetainedString(text), newlines }
}

/** Select by metadata so a progress rewrite never searches completed text. */
export function selectDrawnBlocks(
  blocks: readonly DrawnBlock[],
  truncated = false,
  chars = DRAWN_OUTPUT_CHARS,
  protectSurrogate = true
): DrawnText & { blocks: readonly DrawnBlock[] } {
  const length = blocks.reduce((sum, block) => sum + block.text.length, 0)
  let start = Math.max(0, length - chars)
  let lineStart = 0
  let skipLines = blocks.reduce((sum, block) => sum + block.newlines.length, 0) - DRAWN_OUTPUT_LINES
  if (blocks.at(-1)?.text.endsWith('\n') === false) {
    skipLines += 1
  }
  let offset = 0
  for (const block of blocks) {
    if (protectSurrogate && start > 0 && start >= offset && start < offset + block.text.length) {
      const first = block.text.charCodeAt(start - offset)
      if (first >= 0xdc00 && first <= 0xdfff) {
        start += 1
      }
      protectSurrogate = false
    }
    if (skipLines > 0 && skipLines <= block.newlines.length) {
      lineStart = offset + block.newlines[skipLines - 1] + 1
    }
    skipLines -= block.newlines.length
    offset += block.text.length
  }
  start = Math.max(start, lineStart)
  offset = 0
  const selected: DrawnBlock[] = []
  for (const block of blocks) {
    const cut = start - offset
    if (cut < block.text.length) {
      selected.push(cut > 0 ? drawnBlock(block.text.slice(cut), block.id) : block)
    }
    offset += block.text.length
  }
  return {
    blocks: selected,
    truncated: truncated || start > 0,
    get text() {
      return selected.map((block) => block.text).join('')
    }
  }
}

/** Keep a completed reservoir independent of the current line's temporary budget. */
export function appendDrawnBlocks(previous: DrawnText, text: string): DrawnText {
  if (!text) {
    return previous
  }
  const limit = DRAWN_OUTPUT_CHARS + 2
  const omitted = text.length > limit
  let suffix = omitted ? text.slice(-limit) : text
  const blocks = omitted ? [] : [...(previous.blocks ?? [])]
  const lastBlock = blocks.at(-1)
  let replacedId: number | undefined
  if (lastBlock && lastBlock.text.length < 8192) {
    blocks.pop()
    suffix = lastBlock.text + suffix
    replacedId = lastBlock.id
  }
  for (let start = 0; start < suffix.length;) {
    let end = Math.min(suffix.length, start + 8192)
    const newline = suffix.slice(start, end).lastIndexOf('\n') + 1
    if (newline > 0) {
      end = start + newline
    }
    const last = suffix.charCodeAt(end - 1)
    if (end < suffix.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1
    }
    blocks.push(drawnBlock(suffix.slice(start, end), start === 0 ? replacedId : undefined))
    start = end
  }
  return selectDrawnBlocks(blocks, previous.truncated || omitted, limit, false)
}

export const EMPTY_DRAWN_TEXT: DrawnText = { text: '', truncated: false }

/** Where the last DRAWN_OUTPUT_LINES lines start; a trailing newline ends the last line. */
function lastLinesStart(text: string): number {
  let cursor = text.endsWith('\n') ? text.length - 1 : text.length
  for (let line = 0; line < DRAWN_OUTPUT_LINES; line += 1) {
    const newline = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) : -1
    if (newline === -1) {
      return 0
    }
    cursor = newline
  }
  return cursor + 1
}

/**
 * The drawn end of `text`. Only the last DRAWN_OUTPUT_CHARS units are scanned, so `text` may be
 * the previous drawn end plus new text: the result is a suffix of the whole output either way.
 */
export function drawnTail(text: string, truncated = false): DrawnText {
  let start = Math.max(0, text.length - DRAWN_OUTPUT_CHARS)
  const first = text.charCodeAt(start)
  // Why: starting on a low surrogate would draw half of a character.
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) {
    start += 1
  }
  const window = start > 0 ? text.slice(start) : text
  const lineStart = lastLinesStart(window)
  if (start + lineStart === 0) {
    return { text, truncated }
  }
  return { text: lineStart > 0 ? window.slice(lineStart) : window, truncated: true }
}

/** The drawn end of saved or static text, with `\r\n` normalised only in the part that is drawn. */
export function drawnText(text: string, truncated = false): DrawnText {
  const drawn = drawnTail(text, truncated)
  return drawn.text.includes('\r\n') ? { ...drawn, text: drawn.text.replace(/\r\n/g, '\n') } : drawn
}
