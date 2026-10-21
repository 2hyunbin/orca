import type { IBufferLine } from '@xterm/xterm'
import { buildEdgeWrappedHttpLogicalLineCandidates } from './edge-wrapped-terminal-http-links'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import { buildWrappedLogicalLine } from './wrapped-terminal-link-ranges'

export function buildTerminalHttpLogicalLines(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
) {
  const nativeWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  return dedupeLogicalLines([
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length > 1
      ? [nativeWrappedLogicalLine]
      : []),
    ...buildHardWrappedHttpLogicalLineCandidates(buffer, bufferLineNumber),
    ...buildEdgeWrappedHttpLogicalLineCandidates(buffer, bufferLineNumber),
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length === 1
      ? [nativeWrappedLogicalLine]
      : [])
  ])
}
