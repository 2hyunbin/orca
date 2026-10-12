import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { sendRemoteRuntimeRequestWithStatusPreflight } from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import type { RuntimeEnvironmentCapabilityOutcome } from './runtime-environment-capability-evidence'
import {
  runtimeEnvironmentRevisionFailure,
  runtimeEnvironmentSendValidation
} from './runtime-environment-revision-guard'

export function sendRuntimeEnvironmentPinnedClose(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  connection: PairedRuntimeConnection
  outcome: RuntimeEnvironmentCapabilityOutcome
  method: string
  params: unknown
  deadline: number
  expectedPairingRevision?: number
  expectedRuntimeId?: string
  envelope?: RuntimeOrchestrationEnvelope
  signal?: AbortSignal
}): Promise<RuntimeRpcResponse<unknown>> {
  const validateBeforeSend = runtimeEnvironmentSendValidation({
    userDataPath: args.userDataPath,
    environment: args.environment,
    method: args.method,
    expectedPairingRevision: args.expectedPairingRevision,
    expectedRuntimeId: args.expectedRuntimeId,
    capabilityOutcome: args.outcome
  })
  const timeoutMs = args.deadline - Date.now()
  if (timeoutMs <= 0) {
    return Promise.reject(
      new RemoteRuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the remote Orca runtime to respond.'
      )
    )
  }
  return sendRemoteRuntimeRequestWithStatusPreflight(
    args.connection,
    args.method,
    args.params,
    timeoutMs,
    (response) =>
      runtimeEnvironmentRevisionFailure(
        args.environment,
        args.expectedPairingRevision,
        args.method,
        args.expectedRuntimeId,
        response.ok ? response._meta.runtimeId : null
      ) ?? validateBeforeSend(),
    args.envelope,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
    args.signal,
    validateBeforeSend
  )
}

export function isRuntimePinnedClose(method: string, expectedRuntimeId?: string): boolean {
  return (
    expectedRuntimeId !== undefined &&
    (method === 'session.tabs.close' || method === 'agentSession.close')
  )
}
