import type { useAppStore } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { chatProviderAgents } from '@/lib/chat-provider-agents'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { readHostStructuredAgents } from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

type Store = ReturnType<typeof useAppStore.getState>
export function menuFacts(store: Store, worktreeId: string) {
  const target = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(store, worktreeId)
  )
  const inventoryKey =
    target?.kind === 'runtime'
      ? getRuntimeAgentInventoryKey(target.environmentId, target.worktreeId)
      : ''
  const inventory = !target
    ? null
    : target.kind === 'runtime'
      ? (store.runtimeDetectedAgentIds[inventoryKey] ?? null)
      : target.kind === 'ssh'
        ? (store.remoteDetectedAgentIds[target.connectionId] ?? null)
        : target.contextKey
          ? (store.localDetectedAgentIdsByContext[target.contextKey] ?? null)
          : store.detectedAgentIds
  const refreshing =
    target?.kind === 'runtime'
      ? store.isRefreshingRuntimeAgents[inventoryKey]
      : target?.kind === 'ssh'
        ? store.isDetectingRemoteAgents[target.connectionId]
        : target?.kind === 'local' && target.contextKey
          ? store.isRefreshingLocalAgentsByContext[target.contextKey]
          : store.isRefreshingAgents
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const inputFor = (agent: TuiAgent) => buildAgentLaunchRouteInput(store, { agent, workspace })
  const input = inputFor('claude')
  const host = parseExecutionHostId(input.executionHostId)
  const status =
    host?.kind === 'runtime'
      ? store.runtimeStatusByEnvironmentId.get(host.environmentId)
      : undefined
  const runtimeId = lastVerifiedRuntimeStatus(status)?.runtimeId
  const pairingRevision =
    host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined
  const settings = store.settings
  const chatAgents = [
    ...new Set([
      ...chatProviderAgents(LOCAL_EXECUTION_HOST_ID, store.runtimeStatusByEnvironmentId),
      ...chatProviderAgents(input.executionHostId, store.runtimeStatusByEnvironmentId),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => settings?.nativeChatProviders?.[agent] === true)
    ])
  ]
  const catalogLoaded =
    Boolean(readHostStructuredAgents(input.executionHostId, store.runtimeStatusByEnvironmentId)) ||
    input.hostCapabilities?.includes(
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    ) === false
  const key = JSON.stringify([
    input.executionHostId,
    toRuntimeWorktreeSelector(worktreeId),
    runtimeId,
    pairingRevision,
    status?.connectionGeneration,
    target,
    inventory,
    Boolean(refreshing),
    store.detectedAgentIds,
    input.hostCapabilities,
    input.clientCapabilities,
    input.projectRuntime,
    input.hostStructuredAgents,
    catalogLoaded,
    chatAgents,
    settings?.experimentalNativeChat,
    settings?.nativeChatProviders,
    settings?.disabledTuiAgents,
    settings?.defaultTuiAgent,
    host?.kind === 'local'
      ? [
          settings?.agentCmdOverrides,
          settings?.agentDefaultArgs,
          settings?.agentDefaultEnv,
          settings?.nativeChatInheritShellEnvironment,
          settings?.nativeChatShellEnvironmentVariables
        ]
      : null
  ])
  return {
    key,
    inputFor,
    input,
    host,
    chatAgents,
    inventory,
    catalogLoaded,
    refreshing,
    runtimeId,
    pairingRevision,
    reconnect: status?.hostContactEpoch ?? 0
  }
}
