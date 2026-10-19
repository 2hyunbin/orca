import { useMemo, useSyncExternalStore } from 'react'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY } from '../../../shared/managed-runtime-install'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../shared/protocol-version'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { useAppStore } from '@/store'
import { chatProviderAgents } from '@/lib/chat-provider-agents'
import { resolveAgentLaunchRoute } from '@/lib/agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import {
  readHostStructuredAgentAvailability,
  subscribeHostStructuredAgentAvailability
} from '@/runtime/host-structured-agent-availability'
import {
  hostStructuredAgentsReadFailed,
  readHostStructuredAgentsForRuntime,
  relearnHostStructuredAgents,
  subscribeHostStructuredAgents
} from '@/runtime/host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

/**
 * Whether an agent's chat program runs on a workspace's host, kept apart from whether its CLI is
 * installed there. `unlearned` is not a no: the facts that decide it have not arrived.
 */
export type ChatProgramObservation = 'available' | 'installable' | 'missing' | 'unlearned'

type HostFactsStore = Pick<AgentLaunchRouteStore, 'runtimeStatusByEnvironmentId'>

/** The host's own answer wins. A host that publishes none, or could not tell, is read through the
 *  rule older hosts imply: Orca's managed program where that host installs it, else the CLI. */
export function readChatProgram(
  store: HostFactsStore,
  agent: TuiAgent,
  host: { executionHostId: string; hostCapabilities: readonly string[] | null },
  detected: readonly TuiAgent[] | null
): ChatProgramObservation {
  const parsed = parseExecutionHostId(host.executionHostId)
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
  const runtimeId =
    parsed?.kind === 'local'
      ? null
      : environmentId
        ? lastVerifiedRuntimeStatus(store.runtimeStatusByEnvironmentId?.get(environmentId))
            ?.runtimeId
        : undefined
  const pairing = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const snapshot = readHostStructuredAgentAvailability(host.executionHostId, runtimeId, pairing)
  const published = snapshot.state === 'received' ? snapshot.byAgent.get(agent) : undefined
  if (published?.chatProgram && published.chatProgram !== 'unknown') {
    return published.chatProgram
  }
  if (detected?.includes(agent)) {
    return 'available'
  }
  const registered = readHostStructuredAgentsForRuntime(host.executionHostId, runtimeId)
  const capabilities = host.hostCapabilities
  if (
    registered?.some((row) => row.agent === agent && row.managedRuntime) &&
    capabilities?.includes(MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY)
  ) {
    return 'installable'
  }
  const catalogPending =
    !registered &&
    capabilities?.includes(CATALOG) === true &&
    runtimeId !== undefined &&
    !hostStructuredAgentsReadFailed(host.executionHostId, runtimeId)
  return detected === null || capabilities === null || catalogPending ? 'unlearned' : 'missing'
}

export function chatProgramOffered(program: ChatProgramObservation): boolean {
  return program === 'available' || program === 'installable'
}

/** Whether choosing `agent` in `workspace` opens it as a chat: it routes to chat there and its
 *  program runs, or installs from the chat, on that host. */
export function agentChoiceOpensAsChat(
  store: AgentLaunchRouteStore,
  agent: TuiAgent,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null
): boolean {
  const input = buildAgentLaunchRouteInput(store, { agent, workspace })
  return (
    resolveAgentLaunchRoute(input) === 'structured-native-chat' &&
    chatProgramOffered(readChatProgram(store, agent, input, detected))
  )
}

/** The agents a picker offers: the detected ones, then the agents the host registered for chat
 *  that open as a chat there without their CLI. */
export function agentsOfferedForLaunch(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  detected: readonly TuiAgent[] | null
): TuiAgent[] {
  const offered = [...(detected ?? [])]
  const host = resolveChatProgramHost(store, workspace)
  for (const agent of chatProviderAgents(
    host.executionHostId,
    store.runtimeStatusByEnvironmentId
  )) {
    if (!offered.includes(agent) && agentChoiceOpensAsChat(store, agent, workspace, detected)) {
      offered.push(agent)
    }
  }
  return offered
}

/** `agentsOfferedForLaunch` for a picker; null while detection is pending, where pickers keep
 *  their catalog fallback. */
export function useAgentsOfferedForLaunch(
  workspace: ProspectiveWorkspace,
  detected: ReadonlySet<TuiAgent> | null
): ReadonlySet<TuiAgent> | null {
  useChatProgramFactsVersion()
  const key = useAppStore((state) =>
    detected === null ? null : agentsOfferedForLaunch(state, workspace, [...detected]).join(',')
  )
  return useMemo(() => (key === null ? null : new Set(key.split(',').filter(isTuiAgent))), [key])
}

/** A choice the user made (default, saved action, override) may be an agent that opens as a chat
 *  without its CLI; automatic fallback still picks only detected agents. */
export function pickChosenOrDetectedAgent(
  store: AgentLaunchRouteStore,
  pick: {
    chosen: TuiAgent | 'blank' | null | undefined
    detected: readonly TuiAgent[] | null
    disabled: readonly TuiAgent[] | null | undefined
    workspace: ProspectiveWorkspace
  }
): TuiAgent | null {
  const { chosen, detected, disabled } = pick
  if (
    chosen &&
    chosen !== 'blank' &&
    isTuiAgentEnabled(chosen, disabled) &&
    agentChoiceOpensAsChat(store, chosen, pick.workspace, detected)
  ) {
    return chosen
  }
  return pickTuiAgent(chosen, detected ?? [], disabled)
}

/** Whether a chosen agent whose CLI is not detected waits on facts that decide if it opens as a
 *  chat, so a pick now could pass over it. */
export function chosenAgentChatUnlearned(
  store: AgentLaunchRouteStore,
  chosen: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[] | null,
  workspace: ProspectiveWorkspace
): boolean {
  // Claude and Codex have no managed program, so waiting could not change their answer.
  if (
    !chosen ||
    chosen === 'blank' ||
    detected?.includes(chosen) ||
    isAgentSessionHandleProvider(chosen)
  ) {
    return false
  }
  const input = buildAgentLaunchRouteInput(store, { agent: chosen, workspace })
  return readChatProgram(store, chosen, input, detected) === 'unlearned'
}

/** The host a launch in `workspace` would run on, with what it advertises. */
export function resolveChatProgramHost(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
): { executionHostId: string; hostCapabilities: readonly string[] | null } {
  return buildAgentLaunchRouteInput(store, { agent: 'claude', workspace })
}

/** Loads what the compatibility rule reads for a host; never rejects. */
export async function acquireChatProgramFacts(
  store: HostFactsStore,
  executionHostId: string,
  hostCapabilities: readonly string[] | null
): Promise<void> {
  const capabilities =
    hostCapabilities ??
    (parseExecutionHostId(executionHostId)?.kind === 'local'
      ? await ensureLocalRuntimeCapabilities()
      : null)
  await relearnHostStructuredAgents(
    executionHostId,
    capabilities,
    store.runtimeStatusByEnvironmentId
  ).catch(() => undefined)
}

let factsVersion = 0
const readFactsVersion = (): number => factsVersion

/** Calls `listener` whenever any input of `readChatProgram` other than the store may have changed. */
export function subscribeChatProgramFacts(listener: () => void): () => void {
  const notify = (): void => {
    factsVersion += 1
    listener()
  }
  const releases = [
    subscribeHostStructuredAgentAvailability(notify),
    subscribeHostStructuredAgents(notify),
    subscribeLocalRuntimeCapabilityObservation(notify)
  ]
  return () => releases.forEach((release) => release())
}

/** Re-renders the caller when host chat-program facts change. */
export function useChatProgramFactsVersion(): number {
  return useSyncExternalStore(subscribeChatProgramFacts, readFactsVersion, readFactsVersion)
}
