import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  readTerminalStreamFrameId
} from '../../../src/shared/terminal-stream-protocol'

export type TerminalSnapshotState = {
  streamId: number
  meta: Record<string, unknown>
  chunks: string[]
}

type StreamingListener = (result: unknown) => void

// Why: a host that always sends an unreadable frame must not turn every resubscribe into another reset.
const UNREADABLE_FRAME_RESET_INTERVAL_MS = 30_000
const MAX_TRACKED_UNREADABLE_STREAMS = 256

export type UnreadableTerminalFrameState = {
  now: () => number
  lastResetAt: number | null
  reportedStreamIds: Set<number>
}

export function createUnreadableTerminalFrameState(
  now: () => number = Date.now
): UnreadableTerminalFrameState {
  return { now, lastResetAt: null, reportedStreamIds: new Set() }
}

type TerminalBinaryFrameOptions = {
  terminalSnapshots: Map<number, TerminalSnapshotState>
  unreadableFrames: UnreadableTerminalFrameState
  getListener: (streamId: number) => StreamingListener | undefined
}

export function handleTerminalBinaryFrame(
  bytes: Uint8Array,
  options: TerminalBinaryFrameOptions
): void {
  const frame = decodeTerminalStreamFrame(bytes)
  if (!frame) {
    const streamId = readTerminalStreamFrameId(bytes)
    if (streamId !== null) {
      // A terminal frame this build can't read (unknown opcode) may carry output.
      reportUnreadableTerminalFrame(options, streamId, bytes[2] ?? -1)
    }
    return
  }
  const listener = options.getListener(frame.streamId)
  if (!listener) {
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Output) {
    listener({
      type: 'data',
      streamId: frame.streamId,
      chunk: decodeTerminalStreamText(frame.payload)
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.OutputSpan) {
    // Hosts before text-only terminal.subscribe send stripped-query output as a span.
    const span = decodeTerminalStreamJson<{ data?: unknown }>(frame.payload)
    if (typeof span?.data !== 'string') {
      reportUnreadableTerminalFrame(options, frame.streamId, frame.opcode)
      return
    }
    listener({ type: 'data', streamId: frame.streamId, chunk: span.data })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    options.terminalSnapshots.set(frame.streamId, {
      streamId: frame.streamId,
      meta,
      chunks: []
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
    const snapshot = options.terminalSnapshots.get(frame.streamId)
    if (!snapshot) {
      return
    }
    snapshot.chunks.push(decodeTerminalStreamText(frame.payload))
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
    const snapshot = options.terminalSnapshots.get(frame.streamId)
    if (!snapshot) {
      return
    }
    options.terminalSnapshots.delete(frame.streamId)
    const kind = snapshot.meta.kind === 'resized' ? 'resized' : 'scrollback'
    listener({
      ...snapshot.meta,
      type: kind,
      streamId: frame.streamId,
      serialized: snapshot.chunks.join('')
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Resized) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    listener({
      ...meta,
      type: 'resized',
      streamId: frame.streamId
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Metadata) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    listener({
      ...meta,
      type: 'metadata',
      streamId: frame.streamId
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Error) {
    listener({
      type: 'error',
      streamId: frame.streamId,
      message: decodeTerminalStreamText(frame.payload)
    })
    return
  }
  reportUnreadableTerminalFrame(options, frame.streamId, frame.opcode)
}

// Why an error event: ending the stream makes the next subscription redraw from a fresh snapshot.
function reportUnreadableTerminalFrame(
  options: TerminalBinaryFrameOptions,
  streamId: number,
  opcode: number
): void {
  const listener = options.getListener(streamId)
  const state = options.unreadableFrames
  if (!listener || state.reportedStreamIds.has(streamId)) {
    return
  }
  if (state.reportedStreamIds.size >= MAX_TRACKED_UNREADABLE_STREAMS) {
    state.reportedStreamIds.clear()
  }
  state.reportedStreamIds.add(streamId)
  const now = state.now()
  const reset =
    state.lastResetAt === null || now - state.lastResetAt >= UNREADABLE_FRAME_RESET_INTERVAL_MS
  console.warn('[terminal-stream] unreadable frame', { streamId, opcode, reset })
  if (!reset) {
    return
  }
  state.lastResetAt = now
  options.terminalSnapshots.delete(streamId)
  listener({
    type: 'error',
    streamId,
    message: `Unsupported terminal stream frame (opcode ${opcode}).`
  })
}
