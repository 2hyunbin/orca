import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import type { ResumableSessionParseState, SessionFileCandidate } from './session-scanner-types'
import {
  invalidateSessionParseCacheEntry,
  type SessionParseResumePoint
} from './session-parse-cache-store'
import { TranscriptMessageChannel } from './session-transcript-channel'
import { mergeSkippedTranscriptRecords } from './session-transcript-record-budget'

const NEWLINE_BYTE = 0x0a

// Why: this layer owns reading a transcript and nothing else. It decides where
// a read starts, drives the parser, publishes the decoded messages to every
// registered consumer, and reports where the read ended. Which of those results
// are cached, listed or indexed belongs to the callers.

export type TranscriptReadStats = {
  incremental: number
  fullParses: number
  // Large transcripts read as their first and last bytes only.
  partialReads: number
  // Transcripts the parser already excluded (Codex workers), re-listed after a
  // write and dismissed without reading. Counted apart from `incremental` so a
  // scan span still shows how much work the early stop actually removed.
  earlyStopped: number
  bytesRead: number
}

export type ResumableTranscriptRead = {
  session: AiVaultSession | null
  /** The fold to resume from next time, and the channel bound to it. */
  resume: SessionParseResumePoint
}

/**
 * Ask for the next read of `path` to be a whole-file `replace`.
 *
 * Why this lives here: a consumer never chooses its own mode. The reader picks
 * `append` or `replace` from the resume point the session list left behind, so a
 * consumer that declined an append has no way to get the span it missed — with
 * an empty index and a warm parse cache, every read arrives as `append`, every
 * one is declined, and nothing is ever indexed. Dropping the resume point is the
 * one lever that changes the next read's mode, and only the reader's own cache
 * owns it.
 *
 * The cost is a re-parse for the session list too. That is the honest price of a
 * second consumer being behind, and it is paid once per file rather than per scan.
 */
export function requestWholeTranscriptRead(path: string): void {
  invalidateSessionParseCacheEntry(path)
}

/**
 * Read an append-only transcript, resuming from `resume` when the file only
 * grew and the recorded offset still sits on a line boundary. Anything else
 * (a rewrite, a truncation, a platform change) re-reads the whole file.
 */
export async function readResumableTranscript(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  resume: SessionParseResumePoint | null
  stateFactory: (messages: TranscriptMessageChannel) => ResumableSessionParseState
  stats?: TranscriptReadStats
  signal?: AbortSignal
}): Promise<ResumableTranscriptRead> {
  const { file } = args.candidate
  const resume = args.resume
  const canResume =
    resume !== null &&
    typeof file.sizeBytes === 'number' &&
    file.sizeBytes >= resume.byteOffset &&
    file.mtimeMs >= resume.mtimeMs &&
    // A changed timestamp without growth signals a rewrite, even at a valid line boundary.
    (file.mtimeMs === resume.mtimeMs || file.sizeBytes > (resume.sizeBytes ?? resume.byteOffset)) &&
    (resume.byteOffset === 0 ||
      (await endsWithNewlineAt(file.path, resume.byteOffset, args.signal)))

  // Clone before consuming: a failed read must not corrupt the cached state,
  // or the next resume would double-count the lines applied before the error.
  const channel = canResume ? resume.channel : new TranscriptMessageChannel()
  const state = canResume ? resume.state.clone() : args.stateFactory(channel)
  const startOffset = canResume ? resume.byteOffset : 0
  // A consumer must never fold a gapped read, so appends to a partial fold stay unpublished.
  const partial = canResume && resume.partial === true
  // Mirrors the reader's entry guard so a dismissed transcript is not reported
  // as an incremental parse that read nothing.
  const stoppedBeforeRead = state.shouldStop?.() === true
  if (args.stats) {
    if (stoppedBeforeRead) {
      args.stats.earlyStopped++
    } else if (canResume) {
      args.stats.incremental++
    } else {
      args.stats.fullParses++
    }
  }

  if (!partial) {
    channel.beginRead({
      candidate: args.candidate,
      mode: canResume ? 'append' : 'replace',
      previousByteOffset: startOffset,
      // Read by a consumer during the read, not here: the fold has decoded
      // nothing yet at this point of a whole-file read.
      identity: () => state.identity?.() ?? null
    })
  }
  try {
    const readResult = await consumeCompleteJsonlLines({
      path: file.path,
      start: startOffset,
      onLine: (line) => state.consumeLine(line),
      // Bound: the optional hooks are declared as methods, so a parser written
      // with method syntax must not lose `this` on the way into the reader.
      onLineBytes: state.consumeLineBytes?.bind(state),
      shouldStop: state.shouldStop?.bind(state),
      signal: args.signal
    })
    if (args.stats) {
      args.stats.bytesRead += readResult.bytesRead
    }

    // The stat this scan displays is current even when nothing new was consumed.
    state.touchFile(file)

    // Keep parity with the one-shot parser: a final unterminated line is shown,
    // but stays out of the resumable state so the (possibly still-growing) line
    // is re-read once complete instead of being half-counted.
    let displayState = state
    if (readResult.trailingPartialLine !== null) {
      const partialLine = readResult.trailingPartialLine
      displayState = state.clone()
      channel.mute(() => displayState.consumeLine(partialLine))
    }

    const session = await displayState.finalize(args.platform)
    channel.finishRead({ session, byteOffset: readResult.consumedThrough, incomplete: false })
    return {
      session,
      resume: {
        state,
        byteOffset: readResult.consumedThrough,
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        channel,
        // An append carries the earlier read's drops forward; a whole-file
        // re-read starts from nothing, because it re-visits those records.
        skippedRecords: mergeSkippedTranscriptRecords(
          canResume ? resume.skippedRecords : [],
          readResult.skippedRecords
        ),
        ...(partial ? { partial: true as const } : {})
      }
    }
  } catch (error) {
    channel.finishRead({
      session: null,
      byteOffset: startOffset,
      incomplete: true,
      cancelled: args.signal?.aborted === true
    })
    throw error
  }
}

// Large enough for Codex, whose first prompt follows ~80-125 KB of session setup.
export const PARTIAL_READ_HEAD_BYTES = 256 * 1024
export const PARTIAL_READ_TAIL_BYTES = 64 * 1024

/**
 * Read only the first and last bytes of a large append-only transcript, for a
 * caller that accepts a row whose counts cover just those parts. The same fold
 * a whole read uses consumes the head, is told about the gap, then consumes the
 * tail. Null means "read it whole": the file is small, the parser cannot take a
 * gap, the head lacks what the row needs, or the tail did not reach a newer
 * timestamp (so the row's last-active time would be wrong).
 *
 * Nothing is published: a consumer must never fold a read with a hole in it.
 */
export async function readPartialTranscript(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  stateFactory: (messages: TranscriptMessageChannel) => ResumableSessionParseState
  stats?: TranscriptReadStats
  signal?: AbortSignal
}): Promise<ResumableTranscriptRead | null> {
  const { file } = args.candidate
  const size = file.sizeBytes
  if (size === undefined || size <= PARTIAL_READ_HEAD_BYTES + PARTIAL_READ_TAIL_BYTES) {
    return null
  }
  const channel = new TranscriptMessageChannel()
  const state = args.stateFactory(channel)
  if (!state.skipToTail) {
    return null
  }
  const fold = {
    onLine: (line: string) => state.consumeLine(line),
    onLineBytes: state.consumeLineBytes?.bind(state),
    shouldStop: state.shouldStop?.bind(state),
    signal: args.signal
  }
  const head = await consumeCompleteJsonlLines({
    path: file.path,
    start: 0,
    stopAt: PARTIAL_READ_HEAD_BYTES,
    ...fold
  })
  addBytesRead(args.stats, head.bytesRead)
  // An excluded transcript (a Codex worker) stops on its first line; the whole
  // read stops there too, and publishes the exclusion as it does today.
  if (state.shouldStop?.() === true || !state.skipToTail()) {
    return null
  }
  const headUpdatedAt = state.identity?.()?.updatedAt ?? null
  const tailStart = Math.max(head.consumedThrough, size - PARTIAL_READ_TAIL_BYTES)
  const tail = await consumeCompleteJsonlLines({
    path: file.path,
    start: tailStart,
    startsMidLine: tailStart > head.consumedThrough,
    ...fold
  })
  addBytesRead(args.stats, tail.bytesRead)
  const tailUpdatedAt = state.identity?.()?.updatedAt ?? null
  if (tailUpdatedAt === null || tailUpdatedAt === headUpdatedAt) {
    return null
  }
  state.touchFile(file)
  // Same display-only trailing line as a resumed read: shown, not folded.
  let displayState = state
  if (tail.trailingPartialLine !== null) {
    displayState = state.clone()
    displayState.consumeLine(tail.trailingPartialLine)
  }
  if (args.stats) {
    args.stats.partialReads++
  }
  return {
    session: await displayState.finalize(args.platform),
    resume: {
      state,
      byteOffset: tail.consumedThrough,
      mtimeMs: file.mtimeMs,
      sizeBytes: size,
      channel,
      skippedRecords: mergeSkippedTranscriptRecords(head.skippedRecords, tail.skippedRecords),
      partial: true
    }
  }
}

function addBytesRead(stats: TranscriptReadStats | undefined, bytes: number): void {
  if (stats) {
    stats.bytesRead += bytes
  }
}

/**
 * Read a transcript whose format is rewritten in place rather than appended
 * (whole-JSON documents, Kimi's state doc, OpenCode). There is no cursor to
 * keep, so every read is a whole-file `replace`.
 */
export async function readWholeTranscript(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  stats?: TranscriptReadStats
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  const { file } = args.candidate
  if (args.stats) {
    args.stats.fullParses++
    args.stats.bytesRead += file.sizeBytes ?? 0
  }
  const channel = new TranscriptMessageChannel()
  channel.beginRead({ candidate: args.candidate, mode: 'replace', previousByteOffset: 0 })
  try {
    const session = await parseAgentSessionFile(args.candidate, args.platform, channel, args.signal)
    channel.finishRead({ session, byteOffset: file.sizeBytes ?? 0, incomplete: false })
    return session
  } catch (error) {
    channel.finishRead({
      session: null,
      byteOffset: 0,
      incomplete: true,
      cancelled: args.signal?.aborted === true
    })
    throw error
  }
}

// A resume point is only valid if it still sits just past a line break;
// anything else means the file was rewritten, not appended. Heuristic: a
// grown rewrite keeping '\n' at exactly this byte would slip through, but
// agent transcripts are append-only so that trade is accepted (worst case is
// a stale vault row until the file is next truncated or the app restarts).
async function endsWithNewlineAt(
  path: string,
  offset: number,
  signal?: AbortSignal
): Promise<boolean> {
  const slice = await readTranscriptSlice(path, offset - 1, 1, 'scan', signal)
  return slice.length === 1 && slice[0] === NEWLINE_BYTE
}
