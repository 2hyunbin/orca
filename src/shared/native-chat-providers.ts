/**
 * Chat providers: which agents open as a chat when Chat UI is on. Only the user's own choices are
 * saved; an agent never chosen starts on when it is Claude or Codex, or when its CLI is installed
 * on this computer. Whether an agent appears at all stays with Settings → Agents.
 */

import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

export type NativeChatProviderChoices = Partial<Record<TuiAgent, boolean>>

export type NativeChatProviderSettings = Pick<GlobalSettings, 'nativeChatProviders'>

export function normalizeNativeChatProviderChoices(value: unknown): NativeChatProviderChoices {
  const choices: NativeChatProviderChoices = {}
  if (!value || typeof value !== 'object') {
    return choices
  }
  for (const [agent, on] of Object.entries(value)) {
    if (isTuiAgent(agent) && typeof on === 'boolean') {
      choices[agent] = on
    }
  }
  return choices
}

/**
 * Whether `agent` opens as a chat. `installedHere` lists this computer's detected agents; null
 * while it has not loaded, which keeps an unchosen agent on rather than flipping it once it loads.
 */
export function isNativeChatProviderOn(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  installedHere: readonly TuiAgent[] | null
): boolean {
  const chosen = settings?.nativeChatProviders?.[agent]
  if (chosen !== undefined) {
    return chosen
  }
  return isAgentSessionHandleProvider(agent) || installedHere === null || installedHere.includes(agent)
}

export function buildNativeChatProviderUpdate(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  on: boolean
): Pick<GlobalSettings, 'nativeChatProviders'> {
  return {
    nativeChatProviders: {
      ...normalizeNativeChatProviderChoices(settings?.nativeChatProviders),
      [agent]: on
    }
  }
}
