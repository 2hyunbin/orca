import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../../shared/protocol-version'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { isNativeChatProviderOn } from '../../../../shared/native-chat-providers'
import { useAppStore } from '@/store'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  readHostStructuredAgents,
  relearnHostStructuredAgents
} from '@/runtime/host-structured-agents'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { buildNewTabAgentMenuRows, type HostChatAnswer } from '@/lib/new-tab-agent-menu-rows'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/local-runtime-capabilities'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'

function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
      return !input.hostStructuredAgents && input.hostCapabilities?.includes(CATALOG) !== false
        ? 'not-yet-known'
        : 'not-on-host'
    case 'remote-execution-host':
      return 'ssh'
    case 'project-runtime':
      return 'wsl'
    case 'runtime-capability':
    case 'client-capability':
      return 'no-chats'
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
    if (['remote', 'remote-execution-host', 'ssh'].includes(support.reason ?? '')) {
      return 'ssh'
    }
    if (['wsl', 'project-runtime'].includes(support.reason ?? '')) {
      return 'wsl'
    }
  }
  return 'not-on-host'
}

export type NewTabAgentMenuModel = ReturnType<typeof useNewTabAgentMenuRows>

export function useNewTabAgentMenuRows(worktreeId: string, open: boolean) {
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const detection = useDetectedAgents(open ? detectionTarget : undefined)
  useHostStructuredAgentsVersion()
  useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    readLocalRuntimeCapabilitiesOrUnknown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  const settings = useAppStore((state) => state.settings)
  const installedHere = useAppStore(readNativeDetectedAgents)
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const facts = useAppStore(
    useShallow((state) => {
      const input = buildAgentLaunchRouteInput(state, { agent: 'claude', workspace })
      const host = parseExecutionHostId(input.executionHostId)
      const status =
        host?.kind === 'runtime'
          ? state.runtimeStatusByEnvironmentId.get(host.environmentId)
          : undefined
      return {
        executionHostId: input.executionHostId,
        runtimeId: lastVerifiedRuntimeStatus(status)?.runtimeId,
        pairingRevision:
          host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : undefined,
        connection: status?.connectionGeneration,
        reconnect: status?.hostContactEpoch,
        preliminary: hostChatAnswer(input),
        capabilities: input.hostCapabilities?.join(','),
        command: input.executionHostId === 'local' ? state.settings?.agentCmdOverrides : undefined,
        args: input.executionHostId === 'local' ? state.settings?.agentDefaultArgs : undefined,
        env: input.executionHostId === 'local' ? state.settings?.agentDefaultEnv : undefined,
        inheritShell:
          input.executionHostId === 'local'
            ? state.settings?.nativeChatInheritShellEnvironment
            : undefined,
        shellVariables:
          input.executionHostId === 'local'
            ? state.settings?.nativeChatShellEnvironmentVariables
            : undefined
      }
    })
  )
  const state = useAppStore.getState()
  const inputFor = (agent: TuiAgent) => buildAgentLaunchRouteInput(state, { agent, workspace })
  const input = inputFor('claude')
  const catalogLoaded =
    Boolean(readHostStructuredAgents(input.executionHostId, state.runtimeStatusByEnvironmentId)) ||
    input.hostCapabilities?.includes(CATALOG) === false
  const chatAgents = [
    ...new Set([
      ...chatProviderAgents(LOCAL_EXECUTION_HOST_ID, state.runtimeStatusByEnvironmentId),
      ...chatProviderAgents(input.executionHostId, state.runtimeStatusByEnvironmentId),
      ...Object.keys(settings?.nativeChatProviders ?? {})
        .filter(isTuiAgent)
        .filter((agent) => settings?.nativeChatProviders?.[agent] === true)
    ])
  ]
  const enabled = (agent: TuiAgent) =>
    !settings?.disabledTuiAgents?.includes(agent) &&
    isNativeChatProviderOn(settings, agent, installedHere)
  const eligible =
    isNativeChatEnabled(settings) && catalogLoaded && input.hostCapabilities !== null
      ? chatAgents
          .filter(
            (agent) =>
              enabled(agent) && ['yes', 'not-yet-known'].includes(hostChatAnswer(inputFor(agent)))
          )
          .join(',')
      : ''
  // Only launch-affecting configuration retires display reads; unrelated settings do not.
  const owner = useMemo(
    () => ({ ...facts, open, worktreeId, eligible }),
    [facts, open, worktreeId, eligible]
  )
  const [answers, setAnswers] = useState<{
    owner: typeof owner
    values: Map<TuiAgent, HostChatAnswer>
  } | null>(null)
  const needsNativeInventory =
    installedHere === null &&
    chatAgents.some(
      (agent) =>
        !settings?.disabledTuiAgents?.includes(agent) &&
        agent !== 'claude' &&
        agent !== 'codex' &&
        settings?.nativeChatProviders?.[agent] === undefined
    )
  const chatEnabled = isNativeChatEnabled(settings)
  useEffect(() => {
    if (!open || !chatEnabled) {
      return
    }
    const state = useAppStore.getState()
    if (needsNativeInventory) {
      void state.ensureNativeDetectedAgents()
    }
    if (!catalogLoaded) {
      const input = buildAgentLaunchRouteInput(state, {
        agent: 'claude',
        workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
      })
      void relearnHostStructuredAgents(
        input.executionHostId,
        input.hostCapabilities,
        state.runtimeStatusByEnvironmentId
      )
    }
  }, [open, chatEnabled, facts, worktreeId, catalogLoaded, needsNativeInventory])
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(owner.executionHostId)
    if (!owner.open || !target || !owner.eligible) {
      return
    }
    let active = true
    const controller = new AbortController()
    const values = new Map<TuiAgent, HostChatAnswer>()
    const publish = () => {
      if (active) {
        setAnswers({ owner, values: new Map(values) })
      }
    }
    const agents = owner.eligible.split(',').filter(isTuiAgent)
    const timer = setTimeout(() => {
      for (const agent of agents) {
        if (!values.has(agent)) {
          values.set(agent, 'not-on-host')
        }
      }
      publish()
      active = false
      controller.abort()
    }, 10_000)
    for (const agent of agents) {
      void waitForPromiseWithSignal(
        askHostCreateSupport(target, toRuntimeWorktreeSelector(worktreeId), agent, {
          signal: controller.signal,
          expectedEnvironmentPairingRevision: owner.pairingRevision,
          expectedEnvironmentRuntimeId: owner.runtimeId
        }),
        controller.signal
      ).then(
        (support) => {
          if (!active) {
            return
          }
          values.set(agent, answerFromSupport(support))
          publish()
          if (values.size === agents.length) {
            clearTimeout(timer)
          }
        },
        () => undefined
      )
    }
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [owner, worktreeId])
  const rows = buildNewTabAgentMenuRows({
    settings,
    installedHere: installedHere,
    detectedOnHost: detection.detectedIds,
    chatAgents,
    catalogLoaded,
    hostChatAnswer: (agent) => {
      const preliminary = hostChatAnswer(inputFor(agent))
      return ['yes', 'not-yet-known'].includes(preliminary)
        ? ((answers?.owner === owner && open ? answers.values.get(agent) : undefined) ??
            'not-yet-known')
        : preliminary
    }
  }).map((row) => ({ ...row, executionHostId: parseExecutionHostId(facts.executionHostId)?.id }))
  return { rows, detection }
}
