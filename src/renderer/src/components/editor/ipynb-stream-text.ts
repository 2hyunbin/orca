import { EMPTY_DRAWN_TEXT, extendDrawnTail, type DrawnText } from './ipynb-output-tail'

/** A live stream's text in parts, so a chunk costs its size plus the drawn end, not the stream. */
export type StreamText = {
  /** The nbformat text: `completed + unfinished`, a rope nothing reads in full while streaming. */
  text: string
  /** Text through the last newline; only ever appended to. */
  completed: string
  /** The line after it, which carriage returns may rewrite. */
  unfinished: string
  /** Drawn end of `completed`: rewriting `unfinished` rebuilds `drawn` from it, not `completed`. */
  completedDrawn: DrawnText
  drawn: DrawnText
  /** `unfinished` ends with `\r`, kept so a growing line is never read to find out. */
  trailingReturn: boolean
}

const EMPTY_STREAM_TEXT: StreamText = {
  text: '',
  completed: '',
  unfinished: '',
  completedDrawn: EMPTY_DRAWN_TEXT,
  drawn: EMPTY_DRAWN_TEXT,
  trailingReturn: false
}

// Why: weak output keys keep cursors off saved notebook data and release them with discarded outputs.
const streamTextByOutput = new WeakMap<Record<string, unknown>, StreamText>()

/** Applies terminal-style `\r` rewrites (progress bars), keeping a trailing `\r` for the next chunk. */
export function collapseCarriageReturns(text: string): string {
  return text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n])/gm, '')
}

function withLines(previous: StreamText, newlyCompleted: string, unfinished: string): StreamText {
  const completed = previous.completed + newlyCompleted
  const completedDrawn = extendDrawnTail(previous.completedDrawn, newlyCompleted)
  return {
    text: completed + unfinished,
    completed,
    unfinished,
    completedDrawn,
    drawn: extendDrawnTail(completedDrawn, unfinished),
    trailingReturn: unfinished.endsWith('\r')
  }
}

function splitAtLastNewline(previous: StreamText, text: string): StreamText {
  const end = text.lastIndexOf('\n') + 1
  return withLines(previous, text.slice(0, end), text.slice(end))
}

function appendStreamText(previous: StreamText, chunk: string): StreamText {
  if (previous.trailingReturn || chunk.includes('\r')) {
    // Why: carriage returns can rewrite only the unfinished line, never the LF-completed prefix.
    return splitAtLastNewline(previous, collapseCarriageReturns(previous.unfinished + chunk))
  }
  const end = chunk.lastIndexOf('\n') + 1
  if (end > 0) {
    return withLines(previous, previous.unfinished + chunk.slice(0, end), chunk.slice(end))
  }
  // Why: a line with no newline yet grows without copying `completed` or reading `unfinished`.
  return {
    ...previous,
    text: previous.text + chunk,
    unfinished: previous.unfinished + chunk,
    drawn: extendDrawnTail(previous.drawn, chunk)
  }
}

/** The stream's text after `chunk`; `previous` is the output the chunk extends, if any. */
export function appendStreamChunk(
  previous: Record<string, unknown> | undefined,
  chunk: string
): StreamText {
  const previousText = previous ? String(previous.text) : ''
  const cached = previous ? streamTextByOutput.get(previous) : undefined
  return cached && cached.text === previousText
    ? appendStreamText(cached, chunk)
    : splitAtLastNewline(EMPTY_STREAM_TEXT, collapseCarriageReturns(previousText + chunk))
}

export function rememberStreamText(output: Record<string, unknown>, stream: StreamText): void {
  streamTextByOutput.set(output, stream)
}

/** The drawn end of a live stream output, read without touching its whole text. */
export function liveStreamDrawnText(output: Record<string, unknown>): DrawnText | undefined {
  return streamTextByOutput.get(output)?.drawn
}
