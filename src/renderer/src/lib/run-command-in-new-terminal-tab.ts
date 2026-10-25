import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'

/** Reveals the workspace and runs a shell command in a fresh terminal tab on its execution host. */
export function runCommandInNewTerminalTab(worktreeId: string, command: string): boolean {
  if (!activateAndRevealWorktree(worktreeId)) {
    return false
  }
  const store = useAppStore.getState()
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: the paired host owns the tab; a local createTab would race its snapshot.
    void createWebRuntimeSessionTerminal({
      worktreeId,
      environmentId: runtimeEnvironmentId,
      command,
      activate: true
    }).then((outcome) => {
      if (outcome.status === 'created') {
        useAppStore.getState().setActiveTabType('terminal', worktreeId)
      }
    })
    return true
  }
  const tab = store.createTab(worktreeId, undefined, undefined, { pendingStartup: { command } })
  store.setActiveTabType('terminal', worktreeId)
  persistAgentLaunchTabOrder(worktreeId, tab.id)
  return true
}
