import type { RefObject } from 'react'

export type RestoredViewportBlankingPanesRef = RefObject<Set<number>>

export function buildFreshShellViewportBlankingSequence(rows: number): string {
  const viewportRows = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 24))
  // Newlines preserve scrollback where CSI S discards it; reset stale margins first.
  return `\x1b[?6l\x1b[r\x1b[${viewportRows};1H${'\r\n'.repeat(viewportRows)}\x1b[H`
}
