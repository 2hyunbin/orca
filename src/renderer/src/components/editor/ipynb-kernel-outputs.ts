import { ownRetainedString } from '../../../../shared/own-retained-string'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { isRecord } from './ipynb-parse'

/** An nbformat v4 output; while live it may also carry the kernel's `transient.display_id`. */
export type NotebookOutput = Record<string, unknown>

export type LiveOutputs = {
  outputs: NotebookOutput[]
  /** `clear_output(wait=True)`: clear when the next output arrives, so updates do not flicker. */
  clearOnNextOutput: boolean
}

type StreamText = { text: string; tailStart: number; trailingReturn: boolean }

// Why: weak output keys keep cursors off saved notebook data and release them with discarded outputs.
const streamTextByOutput = new WeakMap<NotebookOutput, StreamText>()

const STREAM_NORMALIZATION_WINDOW = 64 * 1024

function rewriteCarriageReturnLines(text: string): string {
  return text.replace(/^[^\n]*\r(?=[^\n])/gm, '')
}

/** Applies terminal-style `\r` rewrites (progress bars), keeping a trailing `\r` for the next chunk. */
export function collapseCarriageReturns(text: string): string {
  if (text.length > STREAM_NORMALIZATION_WINDOW) {
    return collapseLargeStreamCarriageReturns(text)
  }
  return text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n])/gm, '')
}

function collapseLargeStreamCarriageReturns(text: string): string {
  const firstReturn = text.indexOf('\r')
  if (firstReturn === -1) {
    return text
  }
  const firstNewline = text.indexOf('\n')
  if (firstNewline === -1) {
    const lastRewrite = text.lastIndexOf('\r', text.length - 2)
    return lastRewrite === -1 ? text : text.slice(lastRewrite + 1)
  }
  if (!text.includes('\n', firstNewline + 1)) {
    return rewriteCarriageReturnLines(text.replace(/\r+\n/g, '\n'))
  }
  const prefixStart = Math.max(0, firstReturn - STREAM_NORMALIZATION_WINDOW)
  const prefixNewline = text.slice(prefixStart, firstReturn).lastIndexOf('\n')
  const firstLineStart = prefixNewline === -1 ? 0 : prefixStart + prefixNewline + 1
  const chunks: string[] = [text.slice(0, firstLineStart)]
  for (let start = firstLineStart; start < text.length;) {
    const target = Math.min(start + STREAM_NORMALIZATION_WINDOW, text.length)
    // Complete LF-delimited lines keep CR runs and progress rewrites inside one block.
    let end = text.lastIndexOf('\n', target - 1) + 1
    if (end <= start) {
      const nextNewline = text.indexOf('\n', target)
      end = nextNewline === -1 ? text.length : nextNewline + 1
    }
    const block = text.slice(start, end)
    if (block.length > STREAM_NORMALIZATION_WINDOW) {
      chunks.push(rewriteCarriageReturnLines(block.replace(/\r+\n/g, '\n')))
    } else {
      const normalized = block.split(/\r+\n/).join('\n')
      const rewritten = rewriteCarriageReturnLines(normalized)
      chunks.push(rewritten === normalized ? normalized : ownRetainedString(rewritten))
    }
    start = end
  }
  return chunks.join('')
}

function splitStreamText(text: string, prefix = ''): StreamText {
  const tailStart = text.lastIndexOf('\n') + 1
  return {
    text: prefix + text,
    tailStart: prefix.length + tailStart,
    trailingReturn: text.endsWith('\r')
  }
}

function appendStreamText(previous: StreamText, chunk: string): StreamText {
  if (previous.trailingReturn || chunk.includes('\r')) {
    // Why: carriage returns can rewrite only the unfinished line, never the LF-completed prefix.
    return splitStreamText(
      collapseCarriageReturns(previous.text.slice(previous.tailStart) + chunk),
      previous.text.slice(0, previous.tailStart)
    )
  }
  const tailStart = chunk.lastIndexOf('\n') + 1
  // Why: inspecting the growing text (even endsWith) flattens V8 ropes on every frame.
  return {
    text: previous.text + chunk,
    tailStart: tailStart === 0 ? previous.tailStart : previous.text.length + tailStart,
    trailingReturn: false
  }
}

function streamOutput(content: Record<string, unknown>, previous?: NotebookOutput): NotebookOutput {
  const previousText = previous ? String(previous.text) : ''
  const chunk = String(content.text ?? '')
  const cached = previous ? streamTextByOutput.get(previous) : undefined
  const stream =
    cached && cached.text === previousText
      ? appendStreamText(cached, chunk)
      : splitStreamText(collapseCarriageReturns(previousText + chunk))
  const output = previous
    ? { ...previous, text: stream.text }
    : { output_type: 'stream', name: content.name ?? 'stdout', text: stream.text }
  streamTextByOutput.set(output, stream)
  return output
}

function displayId(value: unknown): unknown {
  return isRecord(value) && isRecord(value.transient) ? value.transient.display_id : undefined
}

function toOutput(type: KernelOutputType, content: Record<string, unknown>): NotebookOutput {
  if (type === 'error') {
    return {
      output_type: type,
      ename: content.ename ?? '',
      evalue: content.evalue ?? '',
      traceback: content.traceback ?? []
    }
  }
  const bundle = { data: content.data ?? {}, metadata: content.metadata ?? {} }
  if (type === 'execute_result') {
    return { output_type: type, execution_count: content.execution_count ?? null, ...bundle }
  }
  return displayId(content) === undefined
    ? { output_type: 'display_data', ...bundle }
    : { output_type: 'display_data', ...bundle, transient: content.transient }
}

export function applyKernelOutput<T extends LiveOutputs>(
  live: T,
  type: KernelOutputType,
  content: Record<string, unknown>
): T {
  if (type === 'clear_output') {
    return content.wait
      ? { ...live, clearOnNextOutput: true }
      : { ...live, outputs: [], clearOnNextOutput: false }
  }
  if (type === 'update_display_data') {
    const id = displayId(content)
    return {
      ...live,
      outputs: live.outputs.map((output) =>
        id !== undefined && displayId(output) === id
          ? { ...output, data: content.data ?? {}, metadata: content.metadata ?? {} }
          : output
      )
    }
  }
  const outputs = live.clearOnNextOutput ? [] : live.outputs
  const last = outputs.at(-1)
  if (type === 'stream' && last?.output_type === 'stream' && last.name === content.name) {
    return {
      ...live,
      outputs: [...outputs.slice(0, -1), streamOutput(content, last)],
      clearOnNextOutput: false
    }
  }
  const output = type === 'stream' ? streamOutput(content) : toOutput(type, content)
  return { ...live, outputs: [...outputs, output], clearOnNextOutput: false }
}

/** Drops live-only fields so the outputs are valid nbformat. */
export function toStoredOutputs(outputs: NotebookOutput[]): NotebookOutput[] {
  return outputs.map(({ transient: _transient, ...output }) => output)
}
