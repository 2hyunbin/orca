import { useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import { structuredAgentLaunchSupport, type AgentLaunchRoutingInput } from '@/lib/agent-launch-routing'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import {
  buildNewTabAgentMenuRows,
  type HostChatAnswer,
  type NewTabAgentMenuRow
} from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/local-runtime-capabilities'

function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
      // The launch waits for a host that publishes its list and has not yet; mirror that here.
      return !input.hostStructuredAgents &&
        input.hostCapabilities?.includes(
          STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
        ) !== false
        ? 'not-yet-known'
        : 'not-on-host'
    case 'remote-execution-host':
      return 'ssh'
    case 'project-runtime':
      return 'wsl'
    case 'runtime-capability':
    case 'client-capability':
      return 'no-chats'
    // Per-launch blockers a menu row never carries: it names no start directory or terminal.
    case 'custom-start-directory':
    case 'reused-terminal':
      return 'yes'
  }
}

/** The menu rows for a workspace, decided by the same route rules its launches use; null while
 *  the workspace host's agent list has not loaded. */
export function useNewTabAgentMenuRows(
  worktreeId: string,
  detectedOnHost: readonly TuiAgent[] | null
): NewTabAgentMenuRow[] | null {
  useHostStructuredAgentsVersion()
  useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  const store = useAppStore(
    useShallow(
      (state): AgentLaunchRouteStore & Pick<AppState, 'settings'> => ({
        settings: state.settings,
        detectedAgentIds: state.detectedAgentIds,
        runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
        worktreesByRepo: state.worktreesByRepo,
        folderWorkspaces: state.folderWorkspaces,
        projectGroups: state.projectGroups,
        repos: state.repos,
        projects: state.projects,
        activeRepoId: state.activeRepoId,
        activeWorktreeId: state.activeWorktreeId,
        activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
        detectedWorktreesByRepo: state.detectedWorktreesByRepo,
        restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
        runtimeEnvironments: state.runtimeEnvironments,
        runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
        removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds
      })
    )
  )
  if (!detectedOnHost) {
    return null
  }
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const inputFor = (agent: TuiAgent): AgentLaunchRoutingInput =>
    buildAgentLaunchRouteInput(store, { agent, workspace })
  const { executionHostId } = inputFor('claude')
  return buildNewTabAgentMenuRows({
    settings: store.settings,
    installedHere: store.detectedAgentIds ?? null,
    detectedOnHost,
    // The Providers list in settings, plus any agent the workspace's own host registered.
    chatAgents: [
      ...new Set([
        ...chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined),
        ...chatProviderAgents(executionHostId, store.runtimeStatusByEnvironmentId)
      ])
    ],
    hostChatAnswer: (agent) => hostChatAnswer(inputFor(agent))
  })
}
