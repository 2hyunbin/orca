import {
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import {
  getOutputAfterSnapshotSeq,
  normalizeMultiplexSnapshotScrollbackRows
} from './terminal-stream-replay'
import { getTerminalInputSequenceLedger } from './terminal-input-sequence-ledger'
import {
  isMultiplexStreamAttached,
  type MultiplexSubscribeRequest,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { SerializedSnapshot, TerminalMultiplexStream } from './terminal-stream-types'

export type MultiplexPublishedInitialState = {
  isMobile: boolean
  size: { cols: number; rows: number } | null
  displayMode: string
}

function requestedInitialScrollbackRows(request: MultiplexSubscribeRequest): number | undefined {
  return request.client?.type === 'mobile'
    ? undefined
    : normalizeMultiplexSnapshotScrollbackRows(request.snapshotScrollbackRows)
}

/** Why early: the stream's output buffer is live once initialization starts, so the image can be
 *  built while the viewport registration awaits instead of after it (a parallel SnapshotRequest did). */
export function startRequestedInitialSnapshot(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  ptyId: string
): Promise<SerializedSnapshot> | undefined {
  const rows = requestedInitialScrollbackRows(request)
  if (rows === undefined) {
    return undefined
  }
  const image = serializeBudgetedRequestedSnapshot(state.runtime, ptyId, rows)
  image.catch(() => {})
  return image
}

function readTailData(read: { tail: string[] }): string {
  return read.tail.length > 0 ? `${read.tail.join('\r\n')}\r\n` : ''
}

export async function publishMultiplexInitialSnapshot(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  stream: TerminalMultiplexStream,
  earlyRequestedImage?: Promise<SerializedSnapshot>
): Promise<MultiplexPublishedInitialState | null> {
  const { runtime, emit } = state
  const { ptyId } = stream
  const isMobile = stream.isMobile
  const forcedInitialSnapshotTruncated =
    process.env.ORCA_E2E_FORCE_REMOTE_TERMINAL_INITIAL_SNAPSHOT_TRUNCATED === '1'
  const requestedScrollbackRows = requestedInitialScrollbackRows(request)
  let servesScrollbackRequest = false
  let earlyImage = earlyRequestedImage
  // Why: the requested image is exactly what a follow-up SnapshotRequest would return; without one
  // (or with nothing authoritative to serialize) keep the default image and let the client ask.
  const serializeInitial = async () => {
    if (requestedScrollbackRows !== undefined) {
      const requested = await (earlyImage ??
        serializeBudgetedRequestedSnapshot(runtime, ptyId, requestedScrollbackRows))
      // An overflow retry must serialize afresh.
      earlyImage = undefined
      servesScrollbackRequest = requested !== null
      if (requested) {
        return requested
      }
    }
    return serializeBudgetedMobileSnapshot(runtime, ptyId)
  }
  // Why lazy on a served request: the text read is only the null-image fallback, and on a long
  // transcript it costs tens of ms ahead of the image (a SnapshotRequest never paid it).
  const readFallback = () => runtime.readTerminal(request.terminal)
  let read = requestedScrollbackRows === undefined ? await readFallback() : null
  let serialized = await serializeInitial()
  if (!isMultiplexStreamAttached(state, stream)) {
    return null
  }
  let initialOutputOverflowed = forcedInitialSnapshotTruncated
  if (stream.pendingOutputOverflowed) {
    stream.pendingOutput.splice(0)
    stream.pendingOutputBytes = 0
    stream.pendingOutputOverflowed = false
    read = requestedScrollbackRows === undefined ? await readFallback() : null
    serialized = await serializeInitial()
    if (!isMultiplexStreamAttached(state, stream)) {
      return null
    }
    if (stream.pendingOutputOverflowed) {
      initialOutputOverflowed = true
      stream.pendingOutput.splice(0)
      stream.pendingOutputBytes = 0
      stream.pendingOutputOverflowed = false
    }
  }
  const fallbackData = serialized ? '' : readTailData(read ?? (await readFallback()))
  if (!isMultiplexStreamAttached(state, stream)) {
    return null
  }
  const size = runtime.getTerminalSize(ptyId)
  const displayMode = runtime.getMobileDisplayMode(ptyId)
  const layoutSeq = runtime.getLayout(ptyId)?.seq
  // Why: layout versions and output offsets are different sequence domains.
  const snapshotOutputSeq = serialized?.seq
  emit({
    type: 'subscribed',
    streamId: request.streamId,
    terminal: request.terminal,
    cols: serialized?.cols ?? size?.cols,
    rows: serialized?.rows ?? size?.rows,
    displayMode,
    seq: layoutSeq,
    ...((stream.supportsOutputPause || stream.inputSessionId !== null) && {
      capabilities: {
        ...(stream.supportsOutputPause ? { outputPause: 1 as const } : {}),
        ...(stream.inputSessionId !== null ? { inputAck: 1 as const } : {})
      }
    }),
    ...(stream.inputSessionId !== null
      ? { inputLedgerId: getTerminalInputSequenceLedger(runtime).id }
      : {}),
    // Why: retained-tail truncation loses history, not the authoritative latest-screen fallback.
    truncated: initialOutputOverflowed
  })
  sendSnapshotFrames((opcode, payload) => state.sendFrame(request.streamId, opcode, payload), {
    kind: 'scrollback',
    cols: serialized?.cols ?? size?.cols ?? 80,
    rows: serialized?.rows ?? size?.rows ?? 24,
    displayMode,
    seq: snapshotOutputSeq,
    cwd: serialized?.cwd,
    truncated: initialOutputOverflowed,
    truncatedByByteBudget: serialized?.truncatedByByteBudget,
    scrollbackRows: serialized?.scrollbackRows,
    ...(servesScrollbackRequest && !initialOutputOverflowed ? { requestedScrollbackRows } : {}),
    source: serialized?.source,
    kittyKeyboardFlags: serialized?.kittyKeyboardFlags,
    alternateScreen: serialized?.alternateScreen,
    terminalOwner: serialized?.terminalOwner,
    oscLinks: serialized?.oscLinks,
    pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
    data: serialized?.data ?? fallbackData
  })
  // Why: baseline for resize re-stream gating; the client already rewrapped to these cols via the initial snapshot replay.
  stream.lastResizeCols = serialized?.cols ?? size?.cols
  stream.buffering = false
  const pendingOutput = stream.pendingOutput.splice(0)
  if (!initialOutputOverflowed) {
    for (const chunk of pendingOutput) {
      const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotOutputSeq)
      if (uncovered) {
        stream.outputBatcher.push(uncovered.data, uncovered.meta)
      }
    }
  }
  stream.pendingOutputBytes = 0
  stream.pendingOutputOverflowed = false
  stream.outputBatcher.flush()
  return { isMobile, size, displayMode }
}
