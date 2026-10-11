import { RECENT_PTY_OUTPUT_LIMIT, RecentPtyOutputBuffer } from '../../recent-pty-output-buffer'
import {
  appendRecentPtyPathCandidates,
  recentTerminalOutputIncludesPath,
  recentTerminalPathCandidatesIncludePath
} from '../../terminal-output-path-candidates'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function recordRecentPtyOutputForPathProvenance(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string
): void {
  let recentOutputBuffer = output.recentPtyOutputById.get(ptyId)
  if (!recentOutputBuffer) {
    // Boundaries are only owed to the one-time activation backfill; once
    // tracking is live, new buffers keep the read-collapsing hot path.
    recentOutputBuffer = new RecentPtyOutputBuffer({
      preserveChunkBoundaries: !output.recentPtyPathCandidateTrackingActive
    })
    output.recentPtyOutputById.set(ptyId, recentOutputBuffer)
  }
  recentOutputBuffer.append(data)
  if (
    output.recentPtyPathCandidateTrackingActive ||
    // Why: an over-window chunk is stored pre-sliced, so activation backfill
    // could never replay its original text. Extract while intact; oversized
    // chunks are rare, so the desktop-only gate still skips the hot path.
    data.length > RECENT_PTY_OUTPUT_LIMIT
  ) {
    output.recentPtyPathCandidatesById.set(
      ptyId,
      appendRecentPtyPathCandidates(output.recentPtyPathCandidatesById.get(ptyId), data)
    )
  }
}

export function activateRecentPtyPathCandidateTracking(output: RuntimeTerminalOutputOwner): void {
  if (output.recentPtyPathCandidateTrackingActive) {
    return
  }
  output.recentPtyPathCandidateTrackingActive = true
  // Why: synchronous backfill from the retained raw windows so a file tap
  // right after first mobile connect resolves exactly as before the gate.
  // Replay each retained chunk in its original full form: joining or
  // trimming chunks would change the candidate set (e.g. a window cut can
  // shorten an over-4KiB line under the extractor's line guard, minting
  // candidates the eager extractor rejected).
  // Accepted best-effort loss: output that scrolled past the raw window
  // before the first-ever connect no longer yields candidates.
  for (const [ptyId, buffer] of output.recentPtyOutputById) {
    let candidates = output.recentPtyPathCandidatesById.get(ptyId)
    const { chunks, headChunkIsPartial } = buffer.retainedChunks()
    for (let index = 0; index < chunks.length; index += 1) {
      if (index === 0 && headChunkIsPartial) {
        // A pre-sliced over-window chunk was already extracted eagerly at
        // append time (while its original text was intact); replaying its
        // truncated remainder would mint or drop candidates spuriously.
        continue
      }
      candidates = appendRecentPtyPathCandidates(candidates, chunks[index]!)
    }
    if (candidates) {
      output.recentPtyPathCandidatesById.set(ptyId, candidates)
    }
    // Chunk boundaries were owed only to this one-time backfill; return
    // the buffer to the compact read-collapsing steady state.
    buffer.compact()
  }
}

export function hasRecentTerminalOutputPath(
  output: RuntimeTerminalOutputOwner,
  handle: string,
  pathText: string,
  absolutePath: string
): boolean {
  // Why: safety net for any query path that never saw a mobile onReady —
  // lazily backfill so the answer matches pre-gate behavior.
  if (!output.recentPtyPathCandidateTrackingActive) {
    output.host.activateRecentPtyPathCandidateTracking()
  }
  const ptyId = output.host.resolveLeafForHandle(handle)?.ptyId
  const recentOutput = ptyId ? output.recentPtyOutputById.get(ptyId)?.read() : null
  if (recentOutput && recentTerminalOutputIncludesPath(recentOutput, pathText, absolutePath)) {
    return true
  }
  const candidates = ptyId ? output.recentPtyPathCandidatesById.get(ptyId) : null
  return candidates
    ? recentTerminalPathCandidatesIncludePath(candidates, pathText, absolutePath)
    : false
}
