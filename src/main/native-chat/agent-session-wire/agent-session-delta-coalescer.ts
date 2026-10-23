import { appendWithinUtf8ByteLimit } from './agent-session-streamed-text-bounds'
// Server-side coalescing for streamed assistant text.
//
// Providers emit one notification per token. Journaling each one would write a
// row and wake every subscriber per token, so a single long answer costs
// thousands of appends and thousands of stream frames on a phone. Deltas are
// therefore accumulated and flushed on a short window. The host saves suffixes;
// subscriber frames still carry the committed whole value.
//
// The window applies to text only. Lifecycle — an item completing, a turn
// ending, an approval arriving — bypasses it by flushing first, so nothing can
// be journaled ahead of the text that preceded it.

/** Long enough to fold a burst of tokens into one row, short enough that the
 *  text still reads as streaming. */
export const AGENT_SESSION_DELTA_COALESCE_MS = 60

/** Matches the admitted live provider-record envelope. The framer owns record
 * admission; this independently prevents many legal deltas from rebuilding an
 * unbounded string after they have crossed that boundary. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export { AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER } from './agent-session-streamed-text-bounds'
export const AGENT_SESSION_MAX_STREAMS = 256

export type AgentSessionDeltaSnapshot = {
  text: string
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaWindow = {
  baseLength: number
  suffix: string
  text: () => string
  replace?: true
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaCoalescerDeps = {
  /** Called with the FULL text accumulated for the key, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  emitDelta?: (key: string, window: AgentSessionDeltaWindow) => unknown
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  /** Maximum distinct item streams retained at once. */
  maxStreams?: number
  /** The caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  /** Injected by tests so a window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  /** Returns false when a full stream cannot be flushed to admit this new key. */
  append: (key: string, delta: string) => boolean
  /** Emit one stream now, if it has unflushed text. */
  flush: (key: string) => boolean
  /** Emit every stream now. The lifecycle bypass. */
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
  window: (key: string) => AgentSessionDeltaWindow | null
  dirtyWindows: () => { key: string; window: AgentSessionDeltaWindow }[]
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
      observedBytes: number
      truncated: boolean
      dirty: boolean
      admittedLength: number
      pending: string[]
    }
  >()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  const evictable = new Set<string>()

  const windowFor = (key: string): AgentSessionDeltaWindow | null => {
    const stream = streams.get(key)
    if (!stream) {
      return null
    }
    const chunks = stream.chunks
    const length = stream.textLength
    let whole: string | undefined
    return {
      baseLength: stream.admittedLength,
      suffix: stream.truncated ? '' : stream.pending.join(''),
      text: () => (whole ??= chunks.join('').slice(0, length)),
      ...(stream.truncated ? { replace: true as const } : {}),
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    }
  }

  const markFlushed = (key: string): void => {
    const stream = streams.get(key)
    if (stream) {
      stream.dirty = false
      stream.admittedLength = stream.textLength
      stream.pending = []
    }
  }

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    const window = windowFor(key)
    if (!window) {
      return true
    }
    const text = deps.emitDelta ? '' : window.text()
    const emitted = deps.emitDelta
      ? deps.emitDelta(key, window)
      : deps.emit(key, text, {
          text,
          observedBytes: stream.observedBytes,
          truncated: stream.truncated
        })
    if (emitted === false) {
      return false
    }
    markFlushed(key)
    return true
  }

  const scheduleFlush = (): void => {
    cancelTimer ??= schedule(() => {
      cancelTimer = null
      flushAll()
    }, windowMs)
  }

  const flushAll = (): boolean => {
    cancelTimer?.()
    cancelTimer = null
    let emitted = true
    for (const key of streams.keys()) {
      emitted = flushKey(key) && emitted
    }
    if (!emitted) {
      scheduleFlush()
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
          observedBytes: 0,
          truncated: false,
          dirty: false,
          admittedLength: 0,
          pending: []
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
        if (!next.truncated) {
          stream.pending.push(delta)
        }
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
    flush: flushKey,
    flushAll,
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
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
    markFlushed,
    dirtyWindows: () =>
      [...streams].flatMap(([key, stream]) => {
        const window = stream.dirty ? windowFor(key) : null
        return window ? [{ key, window }] : []
      }),
    window: windowFor
  }
}
