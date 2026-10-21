import { useAppStore } from '@/store'
import {
  captureWorkspaceSelection,
  restoreWorkspaceSelection,
  type WorkspaceSelection
} from '@/lib/active-workspace-host'
import {
  clearWorktreeSleepIntent,
  markWorktreeSleepIntent,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import type { HostTerminalStop } from '@/store/terminals/terminal-actions'
import type { WorkspaceSleepNotice } from '../../../../shared/workspace-sleep'
import { preserveSidebarWorktreePosition } from './sleep-worktree-sidebar-position'

type FollowedSleep = {
  settle: (stop: HostTerminalStop) => void
  teardown: Promise<void>
  /** The selection to put back if the sleep fails and the user picked nothing meanwhile. */
  selectionBeforeSleep: WorkspaceSelection | null
}

const followed = new Map<string, FollowedSleep>()

/**
 * The window's side of a sleep main runs, whoever asked: on `started` it hides the workspace and
 * guards its panes before any terminal exits (the notice arrives ahead of every exit), and on
 * `ended` it commits or rolls back those panes and wakes the workspace if the sleep failed.
 */
export function followWorkspaceSleep(notice: WorkspaceSleepNotice): void {
  const { worktreeId } = notice
  if (notice.phase === 'started') {
    // A newer sleep of the same workspace replaces an unfinished one.
    followed.get(worktreeId)?.settle({ failed: true, stoppedPtyIds: [] })
    const state = useAppStore.getState()
    const wasActive = state.activeWorktreeId === worktreeId
    const selectionBeforeSleep = wasActive ? captureWorkspaceSelection(state) : null
    // Why first: clearing the active workspace unmounts its panes, whose exits must not stamp activity.
    markWorktreeSleepIntent(worktreeId)
    if (wasActive) {
      const restoreSidebarPosition = preserveSidebarWorktreePosition(worktreeId)
      state.setActiveWorktree(null)
      restoreSidebarPosition()
    }
    state.shutdownWorktreeBrowsers(worktreeId)
    let settle!: (stop: HostTerminalStop) => void
    const hostStop = new Promise<HostTerminalStop>((resolve) => (settle = resolve))
    const teardown = withWorktreeSleepTeardown(worktreeId, () =>
      useAppStore.getState().shutdownWorktreeTerminals(worktreeId, {
        keepIdentifiers: true,
        hostStop
      })
    ).catch((error: unknown) => {
      console.warn('[sleep-worktree] panes kept awake', { worktreeId, error })
    })
    followed.set(worktreeId, { settle, teardown, selectionBeforeSleep })
    return
  }
  const entry = followed.get(worktreeId)
  followed.delete(worktreeId)
  entry?.settle(
    notice.slept ? { failed: false } : { failed: true, stoppedPtyIds: notice.stoppedPtyIds ?? [] }
  )
  void (entry?.teardown ?? Promise.resolve()).then(() => {
    const state = useAppStore.getState()
    // A failed sleep leaves the workspace awake and retryable; one the user reopened is theirs.
    if (!notice.slept || state.activeWorktreeId === worktreeId) {
      clearWorktreeSleepIntent(worktreeId)
    }
    if (!notice.slept && entry?.selectionBeforeSleep && state.activeWorktreeId === null) {
      restoreWorkspaceSelection(state, entry.selectionBeforeSleep)
    }
  })
}
