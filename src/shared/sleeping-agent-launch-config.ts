import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { TuiAgent } from './tui-agent'

/** The recipe of a pane main launched without revealing it; resume replays only recorded recipes. */
export type PaneAgentLaunchConfig = {
  worktreeId: string
  tabId: string
  leafId: string
  launchConfig: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
}

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Startup env may contain prompt/pane transport; persist only Orca-managed launch inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}
