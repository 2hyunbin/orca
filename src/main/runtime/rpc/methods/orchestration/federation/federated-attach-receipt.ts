import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import {
  isAgentLaunchModeReceipt,
  isAgentLaunchOutcome,
  type AgentLaunchModeReceipt,
  type AgentLaunchOutcome
} from '../../../../../../shared/agent-launch-intent'

export type RemoteFederatedWorkerStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch?: string
  worktreeId?: string
  terminalHandle?: string
  agentSession?: AgentLaunchOutcome
  mode?: AgentLaunchModeReceipt
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

export type ReadyRemoteFederatedWorkerStartReceipt = RemoteFederatedWorkerStartReceipt & {
  state: 'ready'
  runtimeEpoch: string
  worktreeId: string
  terminalHandle: string
}

export function parseRemoteFederatedWorkerStartReceipt(
  value: unknown,
  options: { supportsAgentSession?: boolean } = {}
): RemoteFederatedWorkerStartReceipt {
  if (!isRecord(value) || !isNonEmptyString(value.dispatchId) || !isNonEmptyString(value.state)) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  if (
    value.state === 'ready' &&
    (!isNonEmptyString(value.runtimeEpoch) ||
      !isNonEmptyString(value.worktreeId) ||
      !isNonEmptyString(value.terminalHandle))
  ) {
    throw new Error('The worker server returned an invalid ready receipt.')
  }
  if (
    (value.agentSession !== undefined && !isAgentLaunchOutcome(value.agentSession)) ||
    (value.mode !== undefined && !isAgentLaunchModeReceipt(value.mode)) ||
    (value.agentSession !== undefined &&
      isAgentLaunchOutcome(value.agentSession) &&
      value.agentSession.handle !== value.terminalHandle) ||
    (value.agentSession !== undefined &&
      isAgentLaunchOutcome(value.agentSession) &&
      isAgentLaunchModeReceipt(value.mode) &&
      value.agentSession.kind !== value.mode.mode) ||
    (value.state === 'ready' &&
      (value.agentSession === undefined) !== (value.mode === undefined)) ||
    (value.state === 'ready' &&
      options.supportsAgentSession &&
      (value.agentSession === undefined || value.mode === undefined))
  ) {
    throw new Error('The worker server returned an invalid agent-session receipt.')
  }
  return value as RemoteFederatedWorkerStartReceipt
}

export function isReadyRemoteFederatedWorkerStartReceipt(
  receipt: RemoteFederatedWorkerStartReceipt
): receipt is ReadyRemoteFederatedWorkerStartReceipt {
  return receipt.state === 'ready'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
