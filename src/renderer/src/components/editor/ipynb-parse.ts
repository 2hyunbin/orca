import {
  DRAWN_OUTPUT_CHARS,
  DRAWN_OUTPUT_LINES,
  drawnText,
  type DrawnText
} from './ipynb-output-tail'
import { liveStreamDrawnText } from './ipynb-stream-text'

export type IpynbCellKind = 'code' | 'markdown' | 'raw'

/** What a cell draws for an output; text outputs carry only their drawn end. */
export type IpynbOutput =
  | { kind: 'stream'; name: string; drawn: DrawnText }
  | { kind: 'error'; name: string; message: string; drawn: DrawnText }
  | { kind: 'display'; outputType: string; executionCount: number | null; items: IpynbOutputItem[] }

export type IpynbOutputItem = {
  mime: string
  value: unknown
}

export type IpynbCell = {
  id: string | null
  kind: IpynbCellKind
  language: string
  source: string
  executionCount: number | null
  outputs: IpynbOutput[]
}

export type ParsedIpynb = {
  language: string
  cells: IpynbCell[]
}

const DISPLAY_MIME_ORDER = [
  'text/html',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
  'application/json',
  'text/markdown',
  'text/plain'
] as const

const JUPYTER_LANGUAGE_TO_MONACO_LANGUAGE: Record<string, string> = {
  'c#': 'csharp',
  'f#': 'fsharp',
  'q#': 'qsharp',
  'c++11': 'cpp',
  'c++12': 'cpp',
  'c++14': 'cpp',
  'c++': 'cpp'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drawn end of an nbformat multiline string, joining only the lines it can draw. */
function drawnMultilineString(value: unknown): DrawnText {
  if (!Array.isArray(value)) {
    return drawnText(String(value ?? ''))
  }
  let first = value.length
  let remaining = 2 * DRAWN_OUTPUT_CHARS + 2
  const pieces: string[] = []
  let clipped = false
  // Every nonfinal item contributes LF; CRLF can contract the raw suffix by at most half.
  while (first > 0 && pieces.length <= DRAWN_OUTPUT_LINES && remaining > 0) {
    first -= 1
    const item = String(value[first] ?? '')
    const separator = first < value.length - 1 && !item.endsWith('\n') ? '\n' : ''
    const take = Math.max(0, remaining - separator.length)
    clipped = item.length > take
    pieces.push(item.slice(Math.max(0, item.length - take)) + separator)
    remaining -= Math.min(item.length, take) + separator.length
  }
  let suffix = ''
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    suffix += pieces[index]
  }
  return drawnText(suffix.replace(/\r\n/g, '\n'), clipped || first > 0)
}

export function concatIpynbMultilineString(value: unknown): string {
  if (Array.isArray(value)) {
    let result = ''
    for (let i = 0; i < value.length; i += 1) {
      const item = String(value[i] ?? '')
      result += i < value.length - 1 && !item.endsWith('\n') ? `${item}\n` : item
    }
    return result.replace(/\r\n/g, '\n')
  }
  return String(value ?? '').replace(/\r\n/g, '\n')
}

export function translateKernelLanguageToMonaco(language: string | null | undefined): string {
  const normalized = (language ?? 'python').toLowerCase()
  if (normalized.length === 2 && normalized.endsWith('#')) {
    return `${normalized.slice(0, 1)}sharp`
  }
  return JUPYTER_LANGUAGE_TO_MONACO_LANGUAGE[normalized] ?? normalized
}

function getPreferredLanguage(content: Record<string, unknown>): string {
  const metadata = isRecord(content.metadata) ? content.metadata : {}
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {}
  const kernelSpec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {}
  const language =
    typeof languageInfo.name === 'string'
      ? languageInfo.name
      : typeof kernelSpec.language === 'string'
        ? kernelSpec.language
        : 'python'
  return translateKernelLanguageToMonaco(language)
}

function getCellLanguage(cell: Record<string, unknown>, fallback: string): string {
  const metadata = isRecord(cell.metadata) ? cell.metadata : {}
  const vscode = isRecord(metadata.vscode) ? metadata.vscode : {}
  return typeof vscode.languageId === 'string' ? vscode.languageId : fallback
}

function parseDisplayItems(data: unknown): IpynbOutputItem[] {
  if (!isRecord(data)) {
    return []
  }
  return Object.entries(data)
    .map(([mime, value]) => ({ mime, value }))
    .sort((a, b) => {
      const aIndex = DISPLAY_MIME_ORDER.indexOf(a.mime as (typeof DISPLAY_MIME_ORDER)[number])
      const bIndex = DISPLAY_MIME_ORDER.indexOf(b.mime as (typeof DISPLAY_MIME_ORDER)[number])
      return (aIndex === -1 ? 100 : aIndex) - (bIndex === -1 ? 100 : bIndex)
    })
}

function parseOutputRecord(rawOutput: Record<string, unknown>): IpynbOutput | null {
  if (typeof rawOutput.output_type !== 'string') {
    return null
  }

  if (rawOutput.output_type === 'stream') {
    return {
      kind: 'stream',
      name: typeof rawOutput.name === 'string' ? rawOutput.name : 'stdout',
      // Why: a live stream is one growing text; its cursor keeps the drawn end so nothing reads it all.
      drawn: liveStreamDrawnText(rawOutput) ?? drawnMultilineString(rawOutput.text)
    }
  }

  if (rawOutput.output_type === 'error') {
    const name = typeof rawOutput.ename === 'string' ? rawOutput.ename : ''
    const message = typeof rawOutput.evalue === 'string' ? rawOutput.evalue : ''
    const traceback = drawnMultilineString(rawOutput.traceback)
    return {
      kind: 'error',
      name,
      message,
      // Jupyter tracebacks already end with "ename: evalue".
      drawn: traceback.text ? traceback : drawnText(`${name}: ${message}`)
    }
  }

  return {
    kind: 'display',
    outputType: rawOutput.output_type,
    executionCount:
      typeof rawOutput.execution_count === 'number' ? rawOutput.execution_count : null,
    items: parseDisplayItems(rawOutput.data)
  }
}

// Why: a live run re-renders every frame; unchanged outputs keep their object, so they parse once.
const parsedOutputs = new WeakMap<Record<string, unknown>, IpynbOutput | null>()

export function parseIpynbOutput(rawOutput: unknown): IpynbOutput | null {
  if (!isRecord(rawOutput)) {
    return null
  }
  const cached = parsedOutputs.get(rawOutput)
  if (cached !== undefined) {
    return cached
  }
  const parsed = parseOutputRecord(rawOutput)
  parsedOutputs.set(rawOutput, parsed)
  return parsed
}

function parseCell(rawCell: unknown, fallbackLanguage: string): IpynbCell | null {
  if (!isRecord(rawCell)) {
    return null
  }
  const kind =
    rawCell.cell_type === 'markdown' || rawCell.cell_type === 'raw' || rawCell.cell_type === 'code'
      ? rawCell.cell_type
      : null
  if (kind === null) {
    return null
  }

  const outputs = Array.isArray(rawCell.outputs)
    ? rawCell.outputs
        .map(parseIpynbOutput)
        .filter((output): output is IpynbOutput => output !== null)
    : []

  return {
    id: typeof rawCell.id === 'string' ? rawCell.id : null,
    kind,
    language: kind === 'code' ? getCellLanguage(rawCell, fallbackLanguage) : kind,
    source: concatIpynbMultilineString(rawCell.source),
    executionCount: typeof rawCell.execution_count === 'number' ? rawCell.execution_count : null,
    outputs
  }
}

export function parseIpynb(content: string): ParsedIpynb {
  const parsed = JSON.parse(content) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Notebook root must be a JSON object')
  }
  if (!Array.isArray(parsed.cells)) {
    throw new Error('Notebook is missing a cells array')
  }

  const language = getPreferredLanguage(parsed)
  const cells = parsed.cells
    .map((cell) => parseCell(cell, language))
    .filter((cell): cell is IpynbCell => cell !== null)

  return {
    language,
    cells
  }
}
