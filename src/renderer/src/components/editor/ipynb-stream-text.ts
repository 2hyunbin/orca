import {
  DRAWN_OUTPUT_CHARS,
  EMPTY_DRAWN_TEXT,
  appendDrawnBlocks,
  drawnBlock,
  selectDrawnBlocks,
  type DrawnText
} from './ipynb-output-tail'

/** A live stream's text in parts, so a chunk costs its size plus the drawn end, not the stream. */
export type StreamText = {
  /** Complete nbformat text, retained as a rope while streaming. */
  text: string
  /** Text through the last newline; only ever appended to. */
  completed: string
  /** The line after it, without the separately held pending CR. */
  unfinished: string
  unfinishedDrawn: string
  /** Drawn end of `completed`: rewriting `unfinished` rebuilds `drawn` from it, not `completed`. */
  completedDrawn: DrawnText
  drawn: DrawnText
  /** Pending CR is separate so removing it never slices the historical line. */
  trailingReturn: boolean
}

const EMPTY_STREAM_TEXT: StreamText = {
  text: '',
  completed: '',
  unfinished: '',
  unfinishedDrawn: '',
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

function withLines(
  previous: StreamText,
  newlyCompleted: string,
  unfinished: string,
  displayedCompleted = newlyCompleted,
  unfinishedDrawn = unfinished,
  trailingReturn = false
): StreamText {
  const completed = previous.completed + newlyCompleted
  const completedDrawn = appendDrawnBlocks(previous.completedDrawn, displayedCompleted)
  const tail = unfinishedDrawn.slice(-(DRAWN_OUTPUT_CHARS + 2))
  const current = tail + (trailingReturn ? '\r' : '')
  return {
    text: completed + unfinished + (trailingReturn ? '\r' : ''),
    completed,
    unfinished,
    unfinishedDrawn: tail,
    completedDrawn,
    drawn: selectDrawnBlocks(
      [...(completedDrawn.blocks ?? []), ...(current ? [drawnBlock(current, 0)] : [])],
      completedDrawn.truncated || unfinished.length > tail.length
    ),
    trailingReturn
  }
}

function splitAtLastNewline(previous: StreamText, text: string): StreamText {
  const end = text.lastIndexOf('\n') + 1
  const trailingReturn = text.endsWith('\r')
  const unfinished = text.slice(end, trailingReturn ? -1 : undefined)
  return withLines(previous, text.slice(0, end), unfinished, undefined, unfinished, trailingReturn)
}

function appendStreamText(previous: StreamText, chunk: string): StreamText {
  let incoming = chunk
  let discard = false
  if (previous.trailingReturn || chunk.includes('\r')) {
    incoming = ((previous.trailingReturn ? '\r' : '') + chunk).replace(/\r+\n/g, '\n')
    // The old line is CR/LF-free; only a rewrite in the new first line can discard it.
    discard = /^[^\n]*\r(?=[^\n])/.test(incoming)
    incoming = incoming.replace(/^[^\n]*\r(?=[^\n])/gm, '')
  }
  const end = incoming.lastIndexOf('\n') + 1
  const trailingReturn = incoming.endsWith('\r')
  const rest = incoming.slice(end, trailingReturn ? -1 : undefined)
  const kept = discard ? '' : previous.unfinished
  const keptDrawn = discard ? '' : previous.unfinishedDrawn
  return withLines(
    previous,
    end ? kept + incoming.slice(0, end) : '',
    end ? rest : kept + rest,
    end ? keptDrawn + incoming.slice(0, end) : '',
    end ? rest : keptDrawn + rest,
    trailingReturn
  )
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
