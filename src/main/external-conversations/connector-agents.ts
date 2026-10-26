import type { ConnectorAgent } from '../../shared/external-conversation-link'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  isAgentStatusHooksEnabledForAgent,
  type AgentStatusHooksSettings
} from '../../shared/agent-status-hooks-setting'
import { agentArgsSetPermission } from '../../shared/tui-agent-permission-lift'
import { agentPermissionArgs } from '../../shared/tui-agent-permission-choice'

/** The host settings that decide which agents a connector may run, and how. */
export type ConnectorSettings = NonNullable<AgentStatusHooksSettings> &
  Partial<Pick<GlobalSettings, 'agentDefaultArgs'>>

// Membership records mid-turn terminal input support until capability data covers it.
export const CONNECTOR_AGENTS = ['claude', 'codex'] as const satisfies readonly ConnectorAgent[]

export function admitConnectorAgent(
  settings: AgentStatusHooksSettings,
  agent: string
): agent is ConnectorAgent {
  return CONNECTOR_AGENTS.some(
    (candidate) => candidate === agent && isAgentStatusHooksEnabledForAgent(settings, candidate)
  )
}

/**
 * Slack text must never run without approvals: the agent's explicit Ask recipe (which also outranks a
 * bypass in the agent's own config), plus the user's own Arguments unless they set permissions themselves.
 */
export function connectorAgentArgs(agent: ConnectorAgent, settings: ConnectorSettings): string {
  const ask = agentPermissionArgs(agent, 'ask')
  const own = settings.agentDefaultArgs?.[agent]?.trim() ?? ''
  return own && !agentArgsSetPermission(agent, own) ? `${ask} ${own}` : ask
}
