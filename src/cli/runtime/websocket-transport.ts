import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import {
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight
} from '../../shared/remote-runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

export async function sendWebSocketRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequest<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

export async function sendWebSocketRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      validateStatus,
      envelope,
      [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}
