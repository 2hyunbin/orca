import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { relearnHostStructuredAgents } from '@/runtime/host-structured-agents'
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

function answerFromSupport(
  support: Awaited<ReturnType<typeof askHostCreateSupport>>
): HostChatAnswer {
  if (support.kind === 'admitted') {
    return 'yes'
  }
  if (support.kind === 'declined') {
    switch (support.reason) {
      case 'remote':
      case 'remote-execution-host':
      case 'ssh':
        return 'ssh'
      case 'wsl':
      case 'project-runtime':
        return 'wsl'
      case 'agent':
      case 'agent-without-structured-session':
      case 'not-installed':
        return 'not-on-host'
      default:
        return 'not-on-host'
    }
  }
  if (support.kind === 'workspace-unresolved') {
    return 'not-yet-known'
  }
  return 'not-yet-known'
}

type SupportAnswer = Awaited<ReturnType<typeof askHostCreateSupport>>
const supportRequests = new Map<string, Promise<SupportAnswer>>()

function readHostSupport(
  target: Parameters<typeof askHostCreateSupport>[0],
  selector: string,
  agent: TuiAgent
): Promise<SupportAnswer> {
  const key = `${target.kind}:${target.kind === 'environment' ? target.environmentId : 'local'}\u0000${selector}\u0000${agent}`
  const existing = supportRequests.get(key)
  if (existing) {
    return existing
  }
  let timeout: number | undefined
  const request = Promise.race([
    askHostCreateSupport(target, selector, agent),
    new Promise<SupportAnswer>((resolve) => {
      timeout = window.setTimeout(
        () =>
          resolve({
            kind: 'unreachable',
            code: 'timeout',
            message: 'timeout',
            error: new Error('timeout')
          }),
        10_000
      )
    })
  ]).finally(() => {
    if (timeout !== undefined) {
      window.clearTimeout(timeout)
    }
    if (supportRequests.get(key) === request) {
      supportRequests.delete(key)
    }
  })
  supportRequests.set(key, request)
  return request
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
    readLocalRuntimeCapabilitiesOrUnknown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  const store = useAppStore(
    useShallow((state): AgentLaunchRouteStore & Pick<AppState, 'settings'> => ({
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
    }))
  )
  const detectedAgents = detectedOnHost ?? []
  const workspace = useMemo(
    () => ({ kind: workspaceKindForWorktreeId(worktreeId), worktreeId }),
    [worktreeId]
  )
  const inputFor = useCallback(
    (agent: TuiAgent): AgentLaunchRoutingInput =>
      buildAgentLaunchRouteInput(store, { agent, workspace }),
    [store, workspace]
  )
  const { executionHostId } = inputFor('claude')
  const chatAgents = useMemo(
    () => [
      ...new Set([
        ...chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined),
        ...chatProviderAgents(executionHostId, store.runtimeStatusByEnvironmentId)
      ])
    ],
    [executionHostId, store.runtimeStatusByEnvironmentId]
  )
  const [supportAnswers, setSupportAnswers] = useState<Map<TuiAgent, HostChatAnswer>>(
    () => new Map()
  )
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    const currentGeneration = generation.current
    setSupportAnswers(new Map())
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (
      !isNativeChatEnabled(store.settings) ||
      !target ||
      typeof window === 'undefined' ||
      !('api' in window)
    ) {
      return
    }
    const currentInput = inputFor('claude')
    if (
      currentInput.hostCapabilities?.includes(
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ) &&
      !currentInput.hostStructuredAgents
    ) {
      void relearnHostStructuredAgents(
        executionHostId,
        currentInput.hostCapabilities,
        store.runtimeStatusByEnvironmentId
      )
    }
    const selector = toRuntimeWorktreeSelector(worktreeId)
    for (const agent of chatAgents) {
      const input = inputFor(agent)
      const preliminary = hostChatAnswer(input)
      if (preliminary === 'ssh' || preliminary === 'wsl' || preliminary === 'no-chats') {
        continue
      }
      void readHostSupport(target, selector, agent).then((support) => {
        if (generation.current !== currentGeneration) {
          return
        }
        setSupportAnswers((previous) => new Map(previous).set(agent, answerFromSupport(support)))
      })
    }
    return () => {
      generation.current += 1
    }
  }, [
    chatAgents,
    executionHostId,
    inputFor,
    store.runtimeStatusByEnvironmentId,
    store.settings,
    worktreeId
  ])
  const rows = buildNewTabAgentMenuRows({
    settings: store.settings,
    installedHere: store.detectedAgentIds ?? null,
    detectedOnHost: detectedAgents,
    chatAgents,
    hostChatAnswer: (agent) =>
      supportAnswers.get(agent) ??
      (() => {
        const answer = hostChatAnswer(inputFor(agent))
        return answer === 'yes' ? 'not-yet-known' : answer
      })()
  })
  return detectedOnHost ? rows : null
}
