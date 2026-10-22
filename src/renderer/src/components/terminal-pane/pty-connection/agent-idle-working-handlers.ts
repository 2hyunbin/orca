import { resolveTerminalPaneOwnerContext } from '../terminal-pane-owner-context'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../../../shared/ephemeral-setup-terminal-worktree-id'
import { isLocalExecutionHost } from '../../../../../shared/execution-host'

import { settleTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installAgentIdleWorkingHandlers(session: ConnectPanePtySession): void {
  session.onAgentBecameWorking = (): void => {
    session.suppressNativeWindowsIdleCodexFocusReports = false
    session.clearSuppressedTitleSideEffects()
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
      session.agentCompletionCoordinator.observeTitleWorking()
    }
    // Why: a new API call refreshes the prompt-cache TTL, so clear any running
    // countdown. The timer will restart when the agent becomes idle again.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearPendingAgentTaskCompleteNotification()
    if (session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
  session.onAgentExited = (): void => {
    // Why: eligibility can disappear transiently during reconnect, but a
    // confirmed shell-title transition is authoritative for native-chat exit.
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    session.clearSuppressedTitleSideEffects()
    session.clearCommandInferredPaneAgent()
    session.requestKnownWindowsShiftEnterReconfirmation()
    // Why: when the terminal title reverts to a plain shell (e.g., "bash", "zsh"),
    // the agent has exited. Clear any running cache timer so the sidebar doesn't
    // show a stale countdown for a tab that no longer has an active Claude session.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearTitleOnlyInterruptTimer()
    // Why: title reversion alone is not process death. The process/PTY tracker
    // owns removing agent rows when the TUI actually exits.
  }
  // Why: inject ORCA_PANE_KEY so global Claude/Codex hooks can attribute their
  // callbacks to the correct Orca pane without resolving worktrees from cwd.
  // The key matches the `${tabId}:${leafId}` composite used for cacheTimerByKey
  // and agentStatusByPaneKey. Treat it as opaque outside Orca.
  session.state = useAppStore.getState()
  session.parsedWorkspaceKey = parseWorkspaceKey(session.deps.worktreeId)
  session.restoredPtyIdForTransport =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  session.ownerContext = resolveTerminalPaneOwnerContext(
    session.state,
    session.deps.worktreeId,
    session.deps.tabId,
    session.restoredPtyIdForTransport
  )
  session.folderWorkspace = session.ownerContext.folderWorkspace
  session.workspaceEnv = { ORCA_WORKSPACE_ID: session.deps.worktreeId }
  if (session.folderWorkspace) {
    session.workspaceEnv.ORCA_PROJECT_GROUP_ID = session.folderWorkspace.projectGroupId
    session.workspaceEnv.ORCA_WORKSPACE_ROOT = session.folderWorkspace.folderPath
  }
  session.paneIdentityEnv = {
    ...session.workspaceEnv,
    ORCA_PANE_KEY: session.cacheKey,
    ORCA_TAB_ID: session.deps.tabId,
    ORCA_WORKTREE_ID: session.deps.worktreeId,
    ...(session.launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: session.launchToken } : {})
  }
  session.paneEnv = {
    ...session.paneStartup?.env,
    ...session.paneIdentityEnv
  }

  session.worktree = session.ownerContext.worktree
  session.worktreeConnectionId = session.ownerContext.connectionId
  session.tab = session.ownerContext.tab
  session.terminalWorktreeRoute = session.ownerContext.route
  session.explicitRuntimeEnvironmentId = session.terminalWorktreeRoute?.runtimeEnvironmentId ?? null
  session.mirroredRuntimeOwners = session.ownerContext.runtimeOwners
  session.mirroredRuntimeEnvironmentId = session.ownerContext.mirroredRuntimeEnvironmentId
  session.terminalOwnerUnresolved = session.ownerContext.unresolved
  session.runtimeEnvironmentId = session.ownerContext.runtimeEnvironmentId
  // Why: host-agnostic synthetic ids (floating terminal, inline setup panels) have no repo
  // row by design, and a worktree row stamped 'local' proves its host on its own — both are
  // resolved-local, not pending hydration (#10151). Only when nothing names the host does
  // `undefined` mean the repo hasn't merged yet; coalescing that to null would fail-open a
  // remote cwd onto the local daemon (ENOENT on Docker SSH paths).
  session.hostAgnosticTerminalWorktree =
    session.deps.worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    isEphemeralSetupTerminalWorktreeId(session.deps.worktreeId)
  session.worktreeProvesLocalHost = isLocalExecutionHost(session.ownerContext.executionHostId)
  session.connectionOwnerHydrating =
    !session.terminalOwnerUnresolved &&
    !session.hostAgnosticTerminalWorktree &&
    !session.worktreeProvesLocalHost &&
    session.runtimeEnvironmentId === null &&
    session.worktreeConnectionId === undefined
  // Why: an SSH host nested under a HUB is execution identity, not permission for the paired client to dial that host.
  // A set id is a relay-era `ssh:` row not yet converted to its managed runtime: the pane never
  // spawns there, the reconnect overlay owns it, and the converted row remounts the pane.
  session.unservedSshTargetId =
    !session.terminalOwnerUnresolved &&
    !session.connectionOwnerHydrating &&
    session.runtimeEnvironmentId === null
      ? (session.worktreeConnectionId ?? null)
      : null
  // Generation is part of ownership: a recovery remount must not join a spawn
  // started by the pane instance it replaced, while StrictMode remounts keep
  // the same generation and may still share their in-flight spawn.
  session.pendingSpawnKey = JSON.stringify([session.cacheKey, session.tabGeneration])
  session.settlePaneAttachAttempt = (status: 'success' | 'failed' | 'timed-out'): void => {
    settleTerminalPaneRecovery(session.deps.tabId, session.terminalRecoveryGeneration, status)
  }
}
