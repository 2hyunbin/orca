/**
 * The bracketed-paste frame Orca writes for pasted text: the renderer's terminal paste and draft
 * paste, and the host's launch prompt, which replaced the desktop's draft paste and must send the
 * same bytes.
 */

const ESCAPE = '\u001b'
const PASTE_TRANSFORM_CHUNK_CODE_UNITS = 64 * 1024
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`

// An inert printable ESC substitute prevents pasted text from closing its frame early.
export function sanitizeBracketedPasteText(text: string, inertEscape = '␛'): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  if (
    text.length > PASTE_TRANSFORM_CHUNK_CODE_UNITS &&
    hasDenseTerminalPasteReplacements(text, ESCAPE, escapeIndex)
  ) {
    return rewriteTerminalPasteChunks(text, escapeIndex, (chunk) =>
      chunk.split(ESCAPE).join(inertEscape)
    )
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${inertEscape}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

export function normalizeTerminalPasteLineEndings(text: string): string {
  // Why: xterm's native paste path converts every clipboard newline to CR.
  // Direct frames must match it or ConPTY TUIs can treat raw LF as submit.
  if (text.length <= PASTE_TRANSFORM_CHUNK_CODE_UNITS) {
    return text.replace(/\r?\n/g, '\r')
  }
  const newlineIndex = text.indexOf('\n')
  if (newlineIndex === -1) {
    return text
  }
  if (!hasDenseTerminalPasteReplacements(text, '\n', newlineIndex)) {
    return text.replace(/\r?\n/g, '\r')
  }
  const start = text.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex
  return rewriteTerminalPasteChunks(text, start, (chunk) =>
    chunk.split('\r\n').join('\n').split('\n').join('\r')
  )
}

export function wrapTerminalBracketedPasteText(text: string): string {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
}

function rewriteTerminalPasteChunks(
  text: string,
  start: number,
  rewrite: (chunk: string) => string
): string {
  const chunks = [text.slice(0, start)]
  let offset = start
  while (offset < text.length) {
    let end = Math.min(text.length, offset + PASTE_TRANSFORM_CHUNK_CODE_UNITS)
    if (text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10) {
      end += 1
    }
    chunks.push(rewrite(text.slice(offset, end)))
    offset = end
  }
  return chunks.join('')
}

function hasDenseTerminalPasteReplacements(text: string, marker: string, first: number): boolean {
  // Keep sparse pastes as source slices; flatten dense replacements in bounded windows.
  const threshold = Math.max(4096, text.length / 16)
  let count = 0
  let index = first
  while (index !== -1) {
    count += 1
    if (count > threshold) {
      return true
    }
    index = text.indexOf(marker, index + 1)
  }
  return false
}
