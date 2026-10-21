import type {
  AgentLaunchSettingsMutation,
  AgentLaunchSettingsSource
} from './agent-launch-settings'
import { normalizeTuiAgentArgsRecord, resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import {
  agentPermissionChoices,
  agentPermissionEnv,
  applyAgentPermissionOverrides,
  applyAllAgentsPermission,
  hasTypedAgentPermission,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { liftAgentPermissionArgs, liftAgentPermissionEnv } from './tui-agent-permission-lift'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

// Agent launch settings writes against the stored permission, including the shapes older clients
// send, which treat the permission flag as part of the Arguments text.

/** An agent's choice changed only when it differs from what it resolves to now. */
export function choiceUpdate(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  choice: AgentPermissionChoice
): AgentLaunchSettingsSource {
  return resolveAgentPermission(agent, settings).choice === choice
    ? {}
    : applyAgentPermissionOverrides(settings, [agent], choice)
}

function hasEnvPermission(agent: TuiAgent): boolean {
  return Object.keys(agentPermissionEnv(agent, 'full-access')).length > 0
}

export function permissionUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: Extract<AgentLaunchSettingsMutation, { type: 'permission' }>
): AgentLaunchSettingsSource {
  const { agent, choice } = mutation
  if (agent) {
    if (choice !== 'default' && !agentPermissionChoices(agent).includes(choice)) {
      throw new Error('This agent does not offer that permission')
    }
    return applyAgentPermissionOverrides(settings, [agent], choice)
  }
  if (choice === 'default') {
    throw new Error('Choose a permission for all agents')
  }
  if (mutation.withoutAuto) {
    const agents = PERMISSION_CHOICE_AGENTS.filter(
      (candidate) => !agentPermissionChoices(candidate).includes('auto')
    )
    return applyAgentPermissionOverrides(settings, agents, choice)
  }
  return applyAllAgentsPermission(settings, choice)
}

/** An older client's Auto/Yolo/Manual switch, as the choice it means. Manual passed no flag. */
export function legacyPermissionsUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: Extract<AgentLaunchSettingsMutation, { type: 'permissions' }>
): AgentLaunchSettingsSource {
  const choice: AgentPermissionChoice =
    mutation.mode === 'yolo' ? 'full-access' : mutation.mode === 'auto' ? 'auto' : 'own'
  if (mutation.agent) {
    return applyAgentPermissionOverrides(settings, [mutation.agent], choice)
  }
  if (mutation.exceptAuto) {
    return permissionUpdates(settings, { type: 'permission', choice, withoutAuto: true })
  }
  return applyAllAgentsPermission(settings, choice)
}

/**
 * Arguments text from a client that sees the flag as part of it. Unchanged text changes nothing;
 * otherwise Orca's flag in it becomes the choice, and text without one means the agent's own.
 */
export function legacyArgumentsUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  value: string
): AgentLaunchSettingsSource {
  if (value.trim() === resolveTuiAgentLaunchArgs(agent, settings).trim()) {
    return {}
  }
  const lifted = liftAgentPermissionArgs(agent, value)
  return {
    agentDefaultArgs: normalizeTuiAgentArgsRecord({
      ...settings.agentDefaultArgs,
      [agent]: lifted.args
    }),
    ...choiceUpdate(settings, agent, lifted.choice ?? 'own')
  }
}

/**
 * Typed-store updates for a client that writes whole Arguments or env records (an older paired
 * client's settings update): each changed agent is read as `legacyArgumentsUpdates` does.
 */
export function legacyLaunchTextUpdates(
  settings: AgentLaunchSettingsSource,
  updates: Pick<AgentLaunchSettingsSource, 'agentDefaultArgs' | 'agentDefaultEnv'>
): AgentLaunchSettingsSource {
  if (!hasTypedAgentPermission(settings)) {
    return updates
  }
  let next: AgentLaunchSettingsSource = { ...settings }
  for (const [agent, value] of Object.entries(updates.agentDefaultArgs ?? {})) {
    if (isTuiAgent(agent) && typeof value === 'string') {
      next = { ...next, ...legacyArgumentsUpdates(next, agent, value) }
    }
  }
  for (const [agent, env] of Object.entries(updates.agentDefaultEnv ?? {})) {
    if (isTuiAgent(agent) && env) {
      next = { ...next, ...legacyEnvUpdates(next, agent, env) }
    }
  }
  return {
    ...(updates.agentDefaultArgs ? { agentDefaultArgs: next.agentDefaultArgs } : {}),
    ...(updates.agentDefaultEnv ? { agentDefaultEnv: next.agentDefaultEnv } : {}),
    agentPermissionOverrides: next.agentPermissionOverrides
  }
}

/** A whole env record as its terminal gets it; for Goose, the bypass entry is the choice. */
export function legacyEnvUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  env: Record<string, string>
): AgentLaunchSettingsSource {
  if (!hasEnvPermission(agent)) {
    return { agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: env } }
  }
  const lifted = liftAgentPermissionEnv(agent, env)
  return {
    agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: lifted.env },
    ...choiceUpdate(settings, agent, lifted.choice ?? 'own')
  }
}
