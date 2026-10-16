import { useCallback, useEffect, useState } from 'react'
import {
  hasPendingParkedRevealPaint,
  onParkedRevealPaintSettled
} from './parked-reveal-paint-signal'

// Why a cap: a slow parse or a pane that never remounts must not hold the old workspace on screen.
export const PARKED_REVEAL_HOLD_MAX_MS = 250

export type ParkedRevealHold = { from: string; to: string }

/**
 * Keeps the outgoing workspace on screen while a parked one remounts, until its saved screens
 * have parsed. Without it the reveal shows the empty remounted pane for a frame or more (#29366).
 */
export function useParkedRevealHold({
  selectedWorktreeId,
  parkedWorktreeIds,
  mountedWorktreeIds
}: {
  selectedWorktreeId: string | null
  parkedWorktreeIds: ReadonlySet<string>
  mountedWorktreeIds: ReadonlySet<string>
}): { hold: ParkedRevealHold | null; releaseHold: () => void } {
  const [tracked, setTracked] = useState<{
    selected: string | null
    hold: ParkedRevealHold | null
  }>({ selected: selectedWorktreeId, hold: null })
  if (tracked.selected !== selectedWorktreeId) {
    // Why the held surface: a reselect mid-hold must keep showing what is actually on screen.
    const from = tracked.hold?.from ?? tracked.selected
    const to = selectedWorktreeId
    // Why during render: deciding in an effect would commit one frame of the empty surface first.
    setTracked({
      selected: to,
      hold:
        from !== null &&
        to !== null &&
        from !== to &&
        parkedWorktreeIds.has(to) &&
        mountedWorktreeIds.has(from)
          ? { from, to }
          : null
    })
  }
  const hold = tracked.selected === selectedWorktreeId ? tracked.hold : null
  const releaseHold = useCallback(() => {
    setTracked((current) => (current.hold ? { ...current, hold: null } : current))
  }, [])
  useEffect(() => {
    if (!hold) {
      return
    }
    // Why now is enough: child effects ran first, so a remount this commit is already pending.
    // A worktree whose parked tabs did not remount (another tab is active) has nothing to wait on.
    if (!hasPendingParkedRevealPaint(hold.to)) {
      releaseHold()
      return
    }
    const timer = setTimeout(releaseHold, PARKED_REVEAL_HOLD_MAX_MS)
    const unsubscribe = onParkedRevealPaintSettled(hold.to, releaseHold)
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [hold, releaseHold])
  return { hold, releaseHold }
}
