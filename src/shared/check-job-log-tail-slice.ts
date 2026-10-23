import {
  clampUtf8TextPrefix,
  clampUtf8TextTail,
  getUtf8ByteLength,
  isUtf8ByteLengthWithinLimit
} from './utf8-byte-limits'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'
import { PR_CHECK_LOG_TAIL_BYTES, sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt'
import { iterateProcessOutputLinesFromEnd } from './process-output-field-scanner'

export { PR_CHECK_LOG_TAIL_BYTES } from './check-job-log-excerpt'

export const PR_CHECK_LOG_TAIL_LINES = 200
export const PR_CHECK_LOG_TAIL_RECENT_LINES = 100
export const PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES = 2
export const PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES = 30
export const PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR = '… earlier errors …'

// Why: install/cache steps can flood the tail; pull a small window around earlier
// error markers so failures remain visible without downloading the full job log.
const ERROR_LINE_PATTERN =
  /(?:##\[error\]|::error::|::error\b|\berror:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)/i

function matchesErrorMarker(candidate: string): boolean {
  return ERROR_LINE_PATTERN.test(
    stripAnsiEscapeSequences(candidate).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
  )
}

function hasErrorMarker(rawLine: string): boolean {
  if (isUtf8ByteLengthWithinLimit(rawLine, PR_CHECK_LOG_TAIL_BYTES)) {
    return matchesErrorMarker(rawLine)
  }
  const windowBytes = PR_CHECK_LOG_TAIL_BYTES / 2
  return (
    matchesErrorMarker(clampUtf8TextPrefix(rawLine, windowBytes)) ||
    matchesErrorMarker(clampUtf8TextTail(rawLine, windowBytes).text)
  )
}

function applyLogTailByteCap(text: string): string {
  if (isUtf8ByteLengthWithinLimit(text, PR_CHECK_LOG_TAIL_BYTES)) {
    return text
  }
  return clampUtf8TextTail(text, PR_CHECK_LOG_TAIL_BYTES).text
}

function joinLogExcerptWithByteCap(prefixLines: string[], recentLines: string[]): string {
  const prefix = prefixLines.join('\n')
  // Oversized prefixes need no exact byte count, including multibyte text.
  const prefixByteLength =
    prefix.length >= PR_CHECK_LOG_TAIL_BYTES ||
    !isUtf8ByteLengthWithinLimit(prefix, PR_CHECK_LOG_TAIL_BYTES)
      ? PR_CHECK_LOG_TAIL_BYTES
      : getUtf8ByteLength(prefix)
  if (prefixByteLength >= PR_CHECK_LOG_TAIL_BYTES) {
    return clampUtf8TextTail(prefix, PR_CHECK_LOG_TAIL_BYTES).text
  }

  const separator = prefix.length > 0 && recentLines.length > 0 ? '\n' : ''
  const recentBudget = PR_CHECK_LOG_TAIL_BYTES - prefixByteLength - getUtf8ByteLength(separator)
  const recentTail = clampUtf8TextTail(recentLines.join('\n'), recentBudget).text
  return `${prefix}${separator}${recentTail}`
}

function collectEarlierErrorLines(lines: Iterator<string>): {
  earlierLines: string[]
  fallbackLines: string[]
} {
  const fallbackLines: string[] = []
  const read = (): IteratorResult<string> => {
    const next = lines.next()
    if (
      !next.done &&
      fallbackLines.length < PR_CHECK_LOG_TAIL_LINES - PR_CHECK_LOG_TAIL_RECENT_LINES
    ) {
      fallbackLines.push(next.value)
    }
    return next
  }
  const newer: string[] = []
  const selected = new Map<number, string>()
  let current = read()
  const older = Array.from({ length: PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES }, read)
  let index = 0
  while (!current.done) {
    if (hasErrorMarker(current.value)) {
      const context = [...newer, current.value]
      for (const line of older) {
        if (!line.done) {
          context.push(line.value)
        }
      }
      for (const [offset, line] of context.entries()) {
        selected.set(index - newer.length + offset, line)
        if (selected.size === PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES) {
          break
        }
      }
    }
    if (selected.size === PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES) {
      break
    }
    newer.push(current.value)
    if (newer.length > PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES) {
      newer.shift()
    }
    const next = older.shift()
    if (!next) {
      break
    }
    current = next
    older.push(read())
    index += 1
  }
  return {
    earlierLines: [...selected].sort(([left], [right]) => right - left).map(([, line]) => line),
    fallbackLines: fallbackLines.toReversed()
  }
}

function buildCheckLogTail(logText: string): string {
  const lines = iterateProcessOutputLinesFromEnd(logText)
  const recentFromEnd: string[] = []
  for (let index = 0; index < PR_CHECK_LOG_TAIL_RECENT_LINES; index += 1) {
    const next = lines.next()
    if (next.done) {
      return applyLogTailByteCap(recentFromEnd.toReversed().join('\n'))
    }
    recentFromEnd.push(next.value)
  }
  const recentLines = recentFromEnd.toReversed()

  const { earlierLines, fallbackLines } = collectEarlierErrorLines(lines)
  if (earlierLines.length === 0) {
    return applyLogTailByteCap([...fallbackLines, ...recentLines].join('\n'))
  }

  // Why: if the recent tail alone exceeds the byte cap, keep the earlier error
  // context visible instead of truncating it back out of the combined excerpt.
  return joinLogExcerptWithByteCap(
    [...earlierLines, PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR],
    recentLines
  )
}

export function sliceCheckLogTail(logText: string): string {
  // Cached excerpts must not pin the downloaded log behind a small V8 slice.
  return sanitizeCheckJobLogExcerpt(buildCheckLogTail(logText))
}
