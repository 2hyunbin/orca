/** Lines of one text output that are drawn; earlier lines stay in the notebook and are saved. */
export const DRAWN_OUTPUT_LINES = 5000
/** UTF-16 units drawn when the last lines are very long, e.g. one line with no breaks. */
export const DRAWN_OUTPUT_CHARS = 1024 * 1024
/** Outputs drawn per cell; the rest stay in the notebook and are saved. */
export const DRAWN_OUTPUTS_PER_CELL = 500

/** The end of an output's text that is drawn, and whether earlier text was left out. */
export type DrawnText = { text: string; truncated: boolean }

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

export function extendDrawnTail(drawn: DrawnText, text: string): DrawnText {
  return text ? drawnTail(drawn.text + text, drawn.truncated) : drawn
}

/** The drawn end of saved or static text, with `\r\n` normalised only in the part that is drawn. */
export function drawnText(text: string, truncated = false): DrawnText {
  const drawn = drawnTail(text, truncated)
  return drawn.text.includes('\r\n') ? { ...drawn, text: drawn.text.replace(/\r\n/g, '\n') } : drawn
}
