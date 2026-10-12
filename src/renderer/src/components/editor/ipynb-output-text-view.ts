/** Lines a text output draws; earlier lines stay in the notebook but are not drawn. */
export const OUTPUT_VIEW_LINE_LIMIT = 5000
// Why: one line with no breaks would otherwise draw unbounded.
export const OUTPUT_VIEW_CHAR_LIMIT = 1024 * 1024

/** The end of an output's text that the cell draws, and whether earlier text was left out. */
export type OutputTextView = { text: string; truncated: boolean }

export function outputTextView(text: string, truncated = false): OutputTextView {
  let start = 0
  let cursor = text.endsWith('\n') ? text.length - 1 : text.length
  for (let lines = 0; lines < OUTPUT_VIEW_LINE_LIMIT; lines += 1) {
    const newline = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) : -1
    if (newline === -1) {
      cursor = -1
      break
    }
    cursor = newline
  }
  if (cursor !== -1) {
    start = cursor + 1
  }
  start = Math.max(start, text.length - OUTPUT_VIEW_CHAR_LIMIT)
  return start > 0 ? { text: text.slice(start), truncated: true } : { text, truncated }
}
