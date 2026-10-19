import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  ensureDetectedAgentsForTarget,
  readDetectedAgentsForTarget
} from '@/lib/agent-detection-target-inventory'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  acquireChatProgramFacts,
  chosenAgentChatUnlearned,
  pickChosenOrDetectedAgent,
  resolveChatProgramHost
} from '@/lib/host-chat-program'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'

// Why bounded: these facts only decide chat vs shell, so a slow host must not hold the workspace empty.
const DEFAULT_CHAT_DETECTION_TIMEOUT_MS = 5_000

/**
 * The host whose agent list picks the default chat; undefined when the workspace opens a shell
 * whatever that list says. Shared by the wait and the open so they cannot drift.
 */
function defaultChatDetectionTarget(
  state: AppState,
  worktreeId: string
): AgentDetectionTarget | undefined {
  // Why: a 'blank' default means the user wants workspaces to open without an agent.
  if (!isNativeChatEnabled(state.settings) || state.settings?.defaultTuiAgent === 'blank') {
    return undefined
  }
  // Why: an unresolved owner is an unknown host, not the local machine.
  return parseAgentDetectionTargetKey(getAgentDetectionTargetKeyForWorktree(state, worktreeId))
}

const workspaceOf = (worktreeId: string) => ({
  kind: workspaceKindForWorktreeId(worktreeId),
  worktreeId
})

/** True when the default chat could open here but the workspace host's agent list, or for a
 *  default whose CLI is not detected, whether its chat program runs there, has not loaded. */
export function emptyWorkspaceDefaultChatAwaitsDetection(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return false
  }
  const detected = readDetectedAgentsForTarget(state, target)
  return (
    detected === null ||
    chosenAgentChatUnlearned(
      state,
      state.settings?.defaultTuiAgent,
      detected,
      workspaceOf(worktreeId)
    )
  )
}

/** Loads the workspace host's agent list and chat facts; resolves on success, failure, or timeout. */
export async function loadEmptyWorkspaceDefaultChatDetection(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return
  }
  const host = resolveChatProgramHost(state, workspaceOf(worktreeId))
  await withTimeout(
    Promise.all([
      ensureDetectedAgentsForTarget(state, target).catch(() => []),
      acquireChatProgramFacts(state, host.executionHostId, host.hostCapabilities)
    ]),
    DEFAULT_CHAT_DETECTION_TIMEOUT_MS,
    undefined
  )
}

/**
 * When the user's new agent tabs open as chat, an empty workspace opens their default agent as a
 * chat instead of a bare shell. Null means nothing opened and the caller seeds the shell; so does
 * `seedShell` when the host declines the chat, since nobody asked for the agent's terminal.
 */
export function openDefaultAgentChatInEmptyWorkspace(
  worktreeId: string,
  seedShell: () => boolean
): { primaryTabId: string | null } | null {
  const state = useAppStore.getState()
  const target = defaultChatDetectionTarget(state, worktreeId)
  if (!target) {
    return null
  }
  // The default may open as a chat without its CLI; automatic picks stay on detected agents.
  const agent = pickChosenOrDetectedAgent(state, {
    chosen: state.settings?.defaultTuiAgent,
    detected: readDetectedAgentsForTarget(state, target),
    disabled: state.settings?.disabledTuiAgents,
    workspace: workspaceOf(worktreeId)
  })
  if (!agent) {
    return null
  }
  // No user gesture: opening this empty workspace is the one action this chat serves.
  const agentSessionLaunchPlan = planAgentSessionLaunch(state, {
    requestId: newAgentLaunchRequestId(),
    agent,
    workspace: workspaceOf(worktreeId)
  })
  // Why: an agent that can only open as a TUI here would replace the shell with a process nobody asked for.
  if (agentSessionLaunchPlan.route === 'terminal-tui') {
    return null
  }
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    launchSource: 'unknown',
    agentSessionLaunchPlan,
    pendingActivationSpawn: true,
    onStructuredHostDeclined: () => ({ opened: seedShell() })
  })
  if (!result) {
    return null
  }
  return { primaryTabId: result.surface.kind === 'host-published' ? null : result.surface.tabId }
}
