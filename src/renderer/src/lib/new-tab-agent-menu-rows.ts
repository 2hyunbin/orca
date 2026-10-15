/**
 * The new tab menu's agent rows. With Chat UI on, each agent whose chat provider is on gets a chat
 * row, disabled with the reason when the workspace's machine cannot run that chat; every other
 * installed agent gets a row that opens its terminal, marked (CLI). With Chat UI off, or on a host
 * that opens no chats, the menu is the plain list of installed agents.
 */

import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isNativeChatProviderOn } from '../../../shared/native-chat-providers'
import {
  isNativeChatEnabled,
  type NativeChatDefaultSettings
} from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'

/** What the workspace's machine says about opening an agent as a chat, installation aside. */
export type HostChatAnswer =
  | 'yes'
  /** Still loading; an unresolved answer must not promise a chat surface. */
  | 'not-yet-known'
  | 'ssh'
  | 'wsl'
  | 'not-on-host'
  /** An older paired server that opens no chats for this client. */
  | 'no-chats'

export type ChatUnavailableReason = 'pending' | 'not-installed' | 'ssh' | 'wsl' | 'not-on-host'

export type NewTabAgentMenuRow =
  | { kind: 'chat'; agent: TuiAgent }
  | { kind: 'chat-unavailable'; agent: TuiAgent; reason: ChatUnavailableReason }
  | { kind: 'cli'; agent: TuiAgent }
  /** Chat UI is off or the host opens no chats: the menu as it always was. */
  | { kind: 'terminal'; agent: TuiAgent }

export type NewTabAgentMenuSettings = NativeChatDefaultSettings &
  Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>

export function orderAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  agents: readonly TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => agents.includes(entry.id))
    .map((entry) => entry.id)
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  // Why: surface the user's configured default first — matches the prior
  // split-button behavior where the default agent was the primary action.
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function buildNewTabAgentMenuRows(args: {
  settings: NewTabAgentMenuSettings | null | undefined
  /** This computer's detected agents, which pick an unchosen provider's default. */
  installedHere: readonly TuiAgent[] | null
  /** The agents detected on the workspace's machine. */
  detectedOnHost: readonly TuiAgent[]
  /** The agents Orca can open as a chat. */
  chatAgents: readonly TuiAgent[]
  hostChatAnswer: (agent: TuiAgent) => HostChatAnswer
}): NewTabAgentMenuRow[] {
  const { settings } = args
  const defaultAgent = settings?.defaultTuiAgent
  const installed = filterEnabledTuiAgents(args.detectedOnHost, settings?.disabledTuiAgents)
  if (!isNativeChatEnabled(settings) || args.hostChatAnswer('claude') === 'no-chats') {
    return orderAgents(defaultAgent, installed).map((agent) => ({ kind: 'terminal', agent }))
  }
  const runnable: TuiAgent[] = []
  const unavailable = new Map<TuiAgent, ChatUnavailableReason>()
  for (const agent of filterEnabledTuiAgents(args.chatAgents, settings?.disabledTuiAgents)) {
    if (!isNativeChatProviderOn(settings, agent, args.installedHere)) {
      continue
    }
    const answer = args.hostChatAnswer(agent)
    if (answer === 'yes') {
      if (installed.includes(agent)) {
        runnable.push(agent)
      } else {
        unavailable.set(agent, 'not-installed')
      }
    } else if (answer === 'not-yet-known') {
      // Keep the enabled provider named while discovery is unresolved. A pending row is
      // represented by the existing unavailable surface until host admission answers.
      unavailable.set(agent, 'pending')
    } else {
      unavailable.set(agent, answer === 'no-chats' ? 'not-on-host' : answer)
    }
  }
  return [
    ...orderAgents(defaultAgent, runnable).map((agent) => ({ kind: 'chat' as const, agent })),
    ...orderAgents(defaultAgent, [...unavailable.keys()]).map((agent) => ({
      kind: 'chat-unavailable' as const,
      agent,
      reason: unavailable.get(agent) ?? 'not-on-host'
    })),
    ...orderAgents(
      defaultAgent,
      installed.filter((agent) => !runnable.includes(agent))
    ).map((agent) => ({ kind: 'cli' as const, agent }))
  ]
}
