import type { AppState } from '../types'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { commitTerminalSurfaceClose } from './terminal-surface-close-intent'

/**
 * A layout-owner build's record of a terminal tab this window closed: main records it through
 * `layout.apply`, or today's close intent does when main cannot. False when a paired server owns
 * the workspace's layout; the caller records it as today.
 */
export function recordTerminalTabCloseThroughLayoutOwner(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  worktreeId: string,
  tabId: string,
  reason: 'user' | 'cleanup'
): boolean {
  // Main's layout names a tab by its tab-bar entry, which a legacy terminal's id can differ from.
  const entryId =
    state.unifiedTabsByWorktree[worktreeId]?.find(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    )?.id ?? tabId
  const keep = (): void => {}
  return sendLayoutCommandToOwner(
    worktreeId,
    { type: 'closeTabs', tabIds: [entryId], recordClose: reason },
    {
      apply: keep,
      asToday: () => commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId }, reason)
    }
  )
}
