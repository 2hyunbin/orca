import { translate } from '@/i18n/i18n'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { noticeOutput } from './ipynb-kernel-runs'
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

// Why: like the old per-process runner's 2 MiB cut, a bigger text block stalls the cell's rendering.
const MAX_STREAM_CHARS = 2 * 1024 * 1024
// Why: images and HTML get more room than text, but a looping display() still has a ceiling.
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024
// Why: each output is its own rendered block; stdout/stderr switches alone add one per flush.
const MAX_OUTPUTS = 2000
const truncationNotices = new WeakSet<NotebookOutput>()
const richOutputSizes = new WeakMap<NotebookOutput, number>()

/** Applies terminal-style `\r` rewrites (progress bars), keeping a trailing `\r` for the next chunk. */
export function collapseCarriageReturns(text: string): string {
  return text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n])/gm, '')
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

function outputSize(output: NotebookOutput): number {
  if (output.output_type === 'stream') {
    return String(output.text).length
  }
  let size = richOutputSizes.get(output)
  if (size === undefined) {
    size = JSON.stringify(output.data ?? output.traceback ?? null).length
    richOutputSizes.set(output, size)
  }
  return size
}

function truncationNotice(): NotebookOutput {
  const notice = noticeOutput(
    translate(
      'auto.components.editor.IpynbViewer.outputTruncated',
      'Output truncated: this cell produced more output than Orca keeps. To keep all of it, write it to a file instead.'
    )
  )
  truncationNotices.add(notice)
  return notice
}

/** Keeps the head of the cell's output within budget, cutting only what this frame added. */
function fitBudget(previous: NotebookOutput[], outputs: NotebookOutput[]): NotebookOutput[] {
  let streamChars = 0
  let totalChars = 0
  for (const output of outputs) {
    const size = outputSize(output)
    totalChars += size
    streamChars += output.output_type === 'stream' ? size : 0
  }
  if (
    outputs.length <= MAX_OUTPUTS &&
    streamChars <= MAX_STREAM_CHARS &&
    totalChars <= MAX_OUTPUT_CHARS
  ) {
    return outputs
  }
  const last = outputs.at(-1)
  let keep = 0
  if (last?.output_type === 'stream' && outputs.length <= MAX_OUTPUTS) {
    const text = String(last.text)
    keep = text.length - Math.max(streamChars - MAX_STREAM_CHARS, totalChars - MAX_OUTPUT_CHARS)
    // Why: never split a surrogate pair at the cut.
    keep -= /[\ud800-\udbff]/.test(text.charAt(keep - 1)) ? 1 : 0
    // Why: text already on screen stays, even when unbudgeted outputs pushed the cell over.
    const shown = outputs.length === previous.length ? String(previous.at(-1)?.text).length : 0
    keep = Math.max(keep, Math.min(shown, text.length))
  }
  return [
    ...outputs.slice(0, -1),
    ...(last && keep > 0 ? [{ ...last, text: String(last.text).slice(0, keep) }] : []),
    truncationNotice()
  ]
}

function appendOutput(
  outputs: NotebookOutput[],
  type: KernelOutputType,
  content: Record<string, unknown>
): NotebookOutput[] {
  const last = outputs.at(-1)
  if (type === 'stream' && last?.output_type === 'stream' && last.name === content.name) {
    return [...outputs.slice(0, -1), streamOutput(content, last)]
  }
  return [...outputs, type === 'stream' ? streamOutput(content) : toOutput(type, content)]
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
  // Why: a run's first error (e.g. the interrupt) and first result always show, even past the budget.
  if (
    (type === 'error' || type === 'execute_result') &&
    !outputs.some((output) => output.output_type === type)
  ) {
    return { ...live, outputs: appendOutput(outputs, type, content), clearOnNextOutput: false }
  }
  if (outputs.some((output) => truncationNotices.has(output))) {
    return live
  }
  return {
    ...live,
    outputs: fitBudget(outputs, appendOutput(outputs, type, content)),
    clearOnNextOutput: false
  }
}

/** Drops live-only fields so the outputs are valid nbformat. */
export function toStoredOutputs(outputs: NotebookOutput[]): NotebookOutput[] {
  return outputs.map(({ transient: _transient, ...output }) => output)
}
