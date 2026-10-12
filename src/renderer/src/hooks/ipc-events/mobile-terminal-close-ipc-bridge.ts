import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'

export function registerMobileAndTerminalCloseIpcBridge(
  unsubs: (() => void)[],
  requestSleepingAgentWake: (worktreeId: string) => void
): void {
  unsubs.push(
    window.api.ui.onSleepWorktree(({ worktreeId }) => {
      void runSleepWorktree(worktreeId)
    })
  )

  unsubs.push(
    window.api.ui.onResumeSleepingAgents(({ worktreeId }) => {
      // Why: a phone opened this worktree; wake its slept agents without changing the desktop's worktree/tab/view.
      requestSleepingAgentWake(worktreeId)
    })
  )
}
