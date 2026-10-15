import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
import { isNativeChatProviderOn } from '../../../../shared/native-chat-providers'
import { useAppStore } from '@/store'
import {
  structuredAgentLaunchSupport,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import type { askHostCreateSupport } from '@/lib/structured-agent-session-host-admission'
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
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { menuFacts } from './tab-agent-menu-facts'
import { acquireMenuHostSupport } from './menu-host-support-query'

function hostChatAnswer(input: AgentLaunchRoutingInput): HostChatAnswer {
  const support = structuredAgentLaunchSupport(input)
  if (support.supported) {
    return 'yes'
  }
  switch (support.blocker) {
    case 'runtime-capability-unknown':
      return 'not-yet-known'
    case 'agent-without-structured-session':
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

let selectionGeneration = 0
export type NewTabAgentMenuModel = ReturnType<typeof useNewTabAgentMenuRows>

/** One finite query set belongs to one open menu, independent of its search/static rendering. */
export function useNewTabAgentMenuRows(worktreeId: string, open: boolean) {
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const detection = useDetectedAgents(open ? detectionTarget : undefined)
  useHostStructuredAgentsVersion()
  useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    readLocalRuntimeCapabilitiesOrUnknown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  useAppStore((state) => menuFacts(state, worktreeId).key)
  const reconnect = useAppStore((state) => menuFacts(state, worktreeId).reconnect)
  const facts = menuFacts(useAppStore.getState(), worktreeId)
  const storeKey = facts.key
  const [refresh, setRefresh] = useState(0)
  const token = useMemo(() => ++selectionGeneration, [open, storeKey, reconnect, refresh])
  const activeSelection = useRef(0)
  activeSelection.current = open ? token : 0
  useEffect(
    () => () => {
      activeSelection.current = 0
    },
    []
  )
  const [answers, setAnswers] = useState<{ token: number; values: Map<TuiAgent, HostChatAnswer> }>(
    () => ({ token: 0, values: new Map() })
  )
  useEffect(() => {
    if (!open) {
      return
    }
    let active = true
    const current = menuFacts(useAppStore.getState(), worktreeId)
    const state = useAppStore.getState()
    const target = structuredAgentSessionTargetForHost(current.input.executionHostId)
    if (
      !target ||
      !isNativeChatEnabled(state.settings) ||
      ['no-chats', 'wsl'].includes(hostChatAnswer(current.input))
    ) {
      return
    }
    const enabled = (agent: TuiAgent) =>
      !state.settings?.disabledTuiAgents?.includes(agent) &&
      isNativeChatProviderOn(state.settings, agent, state.detectedAgentIds) &&
      (state.detectedAgentIds !== null ||
        agent === 'claude' ||
        agent === 'codex' ||
        state.settings?.nativeChatProviders?.[agent] !== undefined)
    if (![...current.chatAgents, ...(current.inventory ?? [])].some(enabled)) {
      return
    }
    if (
      !current.catalogLoaded &&
      current.input.hostCapabilities?.includes(
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      )
    ) {
      void relearnHostStructuredAgents(
        current.input.executionHostId,
        current.input.hostCapabilities,
        state.runtimeStatusByEnvironmentId
      )
    }
    const releases: (() => void)[] = []
    for (const agent of current.chatAgents) {
      const answer = hostChatAnswer(current.inputFor(agent))
      if (
        !['yes', 'not-yet-known'].includes(answer) ||
        current.refreshing ||
        !enabled(agent) ||
        !current.catalogLoaded ||
        current.input.hostCapabilities === null
      ) {
        continue
      }
      const query = acquireMenuHostSupport(
        `${current.key}\u0000${agent}`,
        target,
        toRuntimeWorktreeSelector(worktreeId),
        agent,
        {
          expectedEnvironmentPairingRevision: current.pairingRevision,
          expectedEnvironmentRuntimeId: current.runtimeId
        }
      )
      releases.push(query.release)
      void query.answer.then((support) => {
        if (!active) {
          return
        }
        setAnswers((previous) => ({
          token,
          values: new Map(previous.token === token ? previous.values : []).set(
            agent,
            answerFromSupport(support)
          )
        }))
      })
    }
    return () => {
      active = false
      releases.forEach((release) => release())
    }
  }, [open, storeKey, reconnect, token, refresh, worktreeId])
  const rows = buildNewTabAgentMenuRows({
    settings: useAppStore.getState().settings,
    installedHere: useAppStore.getState().detectedAgentIds,
    detectedOnHost: facts.inventory,
    chatAgents: facts.chatAgents,
    catalogLoaded: facts.catalogLoaded,
    hostChatAnswer: (agent) => {
      const preliminary = hostChatAnswer(facts.inputFor(agent))
      if (!['yes', 'not-yet-known'].includes(preliminary)) {
        return preliminary
      }
      return open && answers.token === token
        ? (answers.values.get(agent) ?? 'not-yet-known')
        : 'not-yet-known'
    }
  }).map((row) => ({
    ...row,
    ...(facts.host
      ? {
          selection: {
            key: `${token}:${facts.key}`,
            executionHostId: facts.host.id
          }
        }
      : {})
  }))
  const validate = (row: NewTabAgentMenuRow): boolean => {
    const current = menuFacts(useAppStore.getState(), worktreeId)
    const valid =
      activeSelection.current === token &&
      open &&
      row.kind !== 'chat-unavailable' &&
      row.selection !== undefined &&
      row.selection.key === `${token}:${current.key}` &&
      current.reconnect === reconnect &&
      rows.some((candidate) => candidate.agent === row.agent && candidate.kind === row.kind) &&
      (row.kind === 'terminal' || current.host !== null)
    if (!valid) {
      setRefresh((value) => value + 1)
    }
    return valid
  }
  return { rows, validate, detection }
}
