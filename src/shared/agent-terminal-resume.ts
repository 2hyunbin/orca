import type { AgentStartupSettings } from './agent-startup-plan-inputs'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'

/** Recipe provenance survives transport until the execution host composes account env. */
export type AgentTerminalResume = {
  recipe:
    | { source: 'host-defaults' }
    | { source: 'current-inputs'; settings: AgentStartupSettings; agentArgs?: string | null }
    | { source: 'saved'; launchConfig?: SleepingAgentLaunchConfig }
  ompResumeFilePath?: string
  resumeInLaunchCwd?: boolean
  codexHome?: string | null
}

export const AGENT_RESUME_HOST_PLAN_CAPABILITY = 'agent-resume.host-plan.v1' as const

/** Capture only launch inputs, never unrelated settings or a prequoted executable. */
export function agentResumeCurrentInputs(
  settings: AgentStartupSettings | null | undefined
): AgentStartupSettings {
  return structuredClone({
    agentCmdOverrides: settings?.agentCmdOverrides,
    agentDefaultArgs: settings?.agentDefaultArgs,
    agentDefaultEnv: settings?.agentDefaultEnv,
    agentPermissionDefault: settings?.agentPermissionDefault,
    agentPermissionOverrides: settings?.agentPermissionOverrides
  })
}

export type TerminalStartupInput =
  | { command: string; resume?: never }
  | { command?: never; resume: AgentTerminalResume }
