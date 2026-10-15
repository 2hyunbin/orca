import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import type {
  AgentLaunchModeReceipt,
  AgentLaunchOutcome
} from '../../../../../../shared/agent-launch-intent'
import type { ReadyRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

export function federatedReadySurfaceReceipt(
  remote: ReadyRemoteFederatedWorkerStartReceipt,
  nativeChatDefault: boolean
): {
  agentSession: AgentLaunchOutcome
  mode: AgentLaunchModeReceipt
} {
  return {
    agentSession: remote.agentSession ?? { kind: 'terminal', handle: remote.terminalHandle },
    mode: remote.mode ?? {
      mode: 'terminal',
      preferred: nativeChatDefault ? 'structured' : 'terminal',
      reason: 'remote_execution_host',
      detail: 'Started a terminal agent worker through the older federation contract.'
    }
  }
}

export type RemoteStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  prompt?: unknown
  failedStage?: string
  lastError?: string
}

export function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported'
  ].includes(code)
}

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt,
  surface?: { mode?: AgentLaunchModeReceipt; agentSession?: AgentLaunchOutcome }
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    ...(surface?.mode ? { mode: surface.mode } : {}),
    ...(surface?.agentSession ? { agentSession: surface.agentSession } : {}),
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
