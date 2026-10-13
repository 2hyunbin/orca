import {
  releaseRemoteRuntimePreparedRequest,
  type RemoteRuntimePendingRequest
} from './remote-runtime-prepared-request-admission'
import { parseRemoteRuntimeRpcFrame } from './remote-runtime-request-frames'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

export function settleRemoteRuntimeRequestRpcFrame(args: {
  plaintext: string
  pendingRequests: Map<string, RemoteRuntimePendingRequest<unknown>>
  onResponse?: (response: RuntimeRpcResponse<unknown>) => void
}): { resolved: boolean; error?: Error } {
  const parsed = parseRemoteRuntimeRpcFrame(args.plaintext)
  if (parsed.type === 'keepalive') {
    return { resolved: false }
  }
  if (parsed.type === 'error') {
    return { resolved: false, error: parsed.error }
  }
  args.onResponse?.(parsed.response)
  const pending = args.pendingRequests.get(parsed.response.id)
  if (!pending) {
    return { resolved: false }
  }
  args.pendingRequests.delete(parsed.response.id)
  clearTimeout(pending.timeout)
  releaseRemoteRuntimePreparedRequest(pending)
  pending.resolve(parsed.response)
  return { resolved: true }
}
