import type { SessionAccumulator } from './session-scanner-types'

/**
 * The gap of a partial read: the middle of the file is never seen. Counts keep
 * what the head saw and the tail adds; the rolling preview and latest prompt are
 * dropped so the tail alone fills them, rather than splicing opening messages
 * onto closing ones or calling an early prompt the latest.
 */
export function skipAccumulatorToTail(accumulator: SessionAccumulator): void {
  accumulator.partial = true
  accumulator.previewMessages = []
  accumulator.previewMessagesTruncated = true
  accumulator.lastUserPrompt = null
}
