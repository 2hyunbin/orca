import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { beginParkedRevealPaint } from '../terminal/parked-reveal-paint-signal'
import { waitForTerminalReplayWritesParsed } from './replay-guard'

/**
 * Tracks a remounted parked tab until its saved screens have parsed, so the workspace reveal can
 * wait for them. Returns the teardown settle for an unmount that comes first.
 */
export function trackParkedRevealPaint(manager: PaneManager, worktreeId: string): () => void {
  const settle = beginParkedRevealPaint(worktreeId)
  const parsed = manager.getPanes().map((pane) => waitForTerminalReplayWritesParsed(pane.terminal))
  void Promise.all(parsed).then(() => {
    // Why a frame: xterm renders parsed rows on its next frame; release with it, not before.
    requestAnimationFrame(settle)
  })
  return settle
}
