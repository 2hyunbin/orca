import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { AgentLaunchWorkspaceFactory } from '../../../../../agent-launch/agent-launch-surface-factories'

export type WorkerWorktreeLaunch = Parameters<AgentLaunchWorkspaceFactory['createWorktree']>[0]

/** Keep local and federated workers on the executor's same first-surface contract. */
export function workerWorktreeLaunchInputs(
  launch: WorkerWorktreeLaunch,
  args: {
    agent: TuiAgent
    setupDecision: 'run' | 'skip' | 'inherit'
    launchPreferences?: AgentLaunchPreferences
  }
) {
  return {
    runHooks: false,
    setupDecision: args.setupDecision,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    createdWithAgent: args.agent,
    ...(launch.promisedAgentChat ? { promisedAgentChat: true } : {}),
    ...(launch.onWorkspaceCreated ? { onWorkspaceCreated: launch.onWorkspaceCreated } : {}),
    ...(launch.startupAgent
      ? {
          startupAgent: launch.startupAgent,
          startupLaunchSource: 'orchestration',
          ...(args.launchPreferences ? { startupLaunchPreferences: args.launchPreferences } : {})
        }
      : {}),
    activate: false
  } as const
}
