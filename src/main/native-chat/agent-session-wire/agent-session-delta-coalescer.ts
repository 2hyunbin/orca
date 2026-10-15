// Server-side coalescing for streamed assistant text.
//
// Providers emit one notification per token. Journaling each one would write a
// row and wake every subscriber per token, so a single long answer costs
// thousands of appends and thousands of stream frames on a phone. Deltas are
// therefore accumulated and flushed on a short window; the journal row is a
// SNAPSHOT of the text so far, which is also what makes dropping intermediate
// frames safe for a reconnecting client.
//
// Because every row is a full snapshot, the window rewrites a stream only once its
// text has grown by a fixed fraction since its last write, so stored bytes stay a
// bounded multiple of the final text, or once it has gone a capped time unwritten,
// so a long answer still visibly moves.
//
// The window applies to text only. Lifecycle — an item completing, a turn
// ending, an approval arriving — bypasses it by flushing first, so nothing can
// be journaled ahead of the text that preceded it.

import { appendWithinUtf8ByteLimit } from './agent-session-streamed-text-utf8-bound'

/** Long enough to fold a burst of tokens into one row, short enough that the
 *  text still reads as streaming. */
export const AGENT_SESSION_DELTA_COALESCE_MS = 60

/** Longest a stream that has grown goes without a write while it streams. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_GAP_MS = 400

/** Matches the admitted live provider-record envelope. The framer owns record
 * admission; this independently prevents many legal deltas from rebuilding an
 * unbounded string after they have crossed that boundary. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export const AGENT_SESSION_MAX_STREAMS = 256

/** Whether a stream written at `writtenLength` has grown enough for the window to rewrite it:
 *  by 32 characters while short, by an eighth once long, which keeps the sum of every snapshot
 *  under about nine times the final text. */
export function agentSessionStreamedTextCheckpointDue(
  writtenLength: number,
  textLength: number
): boolean {
  return (
    writtenLength === 0 ||
    textLength >= Math.max(writtenLength + 32, Math.ceil(writtenLength * 1.125))
  )
}

export type AgentSessionDeltaSnapshot = {
  text: string
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaCoalescerDeps = {
  /** Called with the FULL text accumulated for the key, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  /** Maximum distinct item streams retained at once. */
  maxStreams?: number
  /** The caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  /** Injected by tests so a window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
  /** The clock the time cap reads; injected with `schedule`. */
  now?: () => number
}

export type AgentSessionDeltaCoalescer = {
  /** Returns false when a full stream cannot be flushed to admit this new key. */
  append: (key: string, delta: string) => boolean
  /** Emit one stream now, if it has unflushed text, however little it grew. */
  flush: (key: string) => boolean
  /** Emit every stream with unflushed text now, however little it grew. The lifecycle bypass. */
  flushAll: () => boolean
  /** Drop a stream without emitting — its authoritative body arrived, so the
   *  accumulated text is now the stale copy. */
  forget: (key: string) => void
  dispose: () => void
  /** Bounded last-known state for terminalizing a rejected completion. */
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  /** Streams with text not yet emitted, in arrival order, for a caller that writes them itself. */
  dirty: () => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** The caller wrote this stream's current text itself; nothing is owed until it grows. */
  markFlushed: (key: string) => void
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? defaultSchedule
  const now = deps.now ?? (() => performance.now())
  const maxRetainedBytes = deps.maxRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
  const maxTotalRetainedBytes =
    deps.maxTotalRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
  const maxStreams = Math.max(1, deps.maxStreams ?? AGENT_SESSION_MAX_STREAMS)
  const streams = new Map<
    string,
    {
      chunks: string[]
      retainedBytes: number
      textLength: number
      /** Text length at the stream's last write; the window's growth rule measures from it. */
      writtenLength: number
      /** When the stream was last written, or opened; the window's time cap measures from it. */
      writtenAt: number
      observedBytes: number
      truncated: boolean
      dirty: boolean
    }
  >()
  let totalRetainedBytes = 0
  let timer: { at: number; cancel: () => void } | null = null
  /** A lifecycle flush the sink refused: its retry writes everything owed, not only grown text. */
  let retryOwed = false
  const evictable = new Set<string>()

  /** `windowAt` is when the window closed; a lifecycle flush passes none and writes all owed. */
  const flushKey = (key: string, windowAt?: number): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    // Skipped text stays owed: the window at its time cap, or a lifecycle flush, writes it.
    if (
      windowAt !== undefined &&
      !agentSessionStreamedTextCheckpointDue(stream.writtenLength, stream.textLength) &&
      windowAt < stream.writtenAt + AGENT_SESSION_STREAMED_TEXT_MAX_GAP_MS
    ) {
      return true
    }
    const text = stream.chunks.join('')
    const emitted = deps.emit(key, text, {
      text,
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    })
    if (emitted === false) {
      return false
    }
    stream.dirty = false
    stream.writtenLength = stream.textLength
    stream.writtenAt = now()
    return true
  }

  /** Close the shared window within `ms`; a pending window that closes sooner stands. */
  const scheduleFlush = (ms = windowMs, at = now() + ms): void => {
    if (timer && timer.at <= at) {
      return
    }
    timer?.cancel()
    timer = {
      at,
      cancel: schedule(() => {
        timer = null
        // The planned close counts for the cap, so a timer that fires a little early still writes.
        flushAll(retryOwed ? undefined : Math.max(at, now()))
      }, ms)
    }
  }

  /** Close the window again when the first stream left owed reaches its time cap. */
  const scheduleTimeCap = (): void => {
    let due = Infinity
    for (const stream of streams.values()) {
      if (stream.dirty) {
        due = Math.min(due, stream.writtenAt + AGENT_SESSION_STREAMED_TEXT_MAX_GAP_MS)
      }
    }
    if (due !== Infinity) {
      scheduleFlush(Math.max(0, due - now()), due)
    }
  }

  const cancelWindow = (): void => {
    timer?.cancel()
    timer = null
  }

  const flushAll = (windowAt?: number): boolean => {
    cancelWindow()
    let emitted = true
    for (const key of streams.keys()) {
      emitted = flushKey(key, windowAt) && emitted
    }
    retryOwed = !emitted && (retryOwed || windowAt === undefined)
    if (!emitted) {
      scheduleFlush()
    } else {
      scheduleTimeCap()
    }
    return emitted
  }

  return {
    append: (key, delta) => {
      let stream = streams.get(key)
      if (!stream) {
        // Evict the oldest stream before admitting a new attacker-controlled
        // id. Flush first so the retained prefix is durably visible.
        while (!deps.isProtected?.(key) && evictable.size >= maxStreams) {
          const oldest = evictable.values().next().value
          if (oldest) {
            if (deps.isProtected?.(oldest)) {
              evictable.delete(oldest)
              continue
            }
            // Under sink backpressure the oldest stream must remain available
            // for a later retry; dropping it would lose already-observed output.
            if (!flushKey(oldest)) {
              return false
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.retainedBytes
            }
            streams.delete(oldest)
            evictable.delete(oldest)
          }
          break
        }
        stream = {
          chunks: [],
          retainedBytes: 0,
          textLength: 0,
          writtenLength: 0,
          writtenAt: now(),
          observedBytes: 0,
          truncated: false,
          dirty: false
        }
        if (!deps.isProtected?.(key)) {
          evictable.add(key)
        }
      } else if (deps.isProtected?.(key)) {
        evictable.delete(key)
      }
      const deltaBytes = Buffer.byteLength(delta, 'utf8')
      stream.observedBytes += deltaBytes
      if (!stream.truncated) {
        const availableTotal = Math.max(0, maxTotalRetainedBytes - totalRetainedBytes)
        const streamLimit = Math.min(maxRetainedBytes, stream.retainedBytes + availableTotal)
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          deltaBytes,
          streamLimit
        )
        totalRetainedBytes += next.retainedBytes - stream.retainedBytes
        stream.textLength = next.truncated
          ? (next.chunks[0]?.length ?? 0)
          : stream.textLength + delta.length
        stream.chunks = next.chunks
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        stream.dirty = true
      }
      streams.set(key, stream)
      // One timer for every stream: a shared deadline bounds latency the same
      // way and costs one wakeup per window instead of one per stream.
      scheduleFlush()
      return true
    },
    flush: (key) => flushKey(key),
    flushAll: () => flushAll(),
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelWindow()
      retryOwed = false
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream
        ? {
            text: stream.chunks.join(''),
            observedBytes: stream.observedBytes,
            truncated: stream.truncated
          }
        : null
    },
    dirty: () =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty
          ? [
              {
                key,
                snapshot: {
                  text: stream.chunks.join(''),
                  observedBytes: stream.observedBytes,
                  truncated: stream.truncated
                }
              }
            ]
          : []
      ),
    markFlushed: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.dirty = false
        stream.writtenLength = stream.textLength
        stream.writtenAt = now()
      }
    }
  }
}
