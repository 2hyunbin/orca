import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import type { RuntimeClientTarget } from './runtime-client-target'

import { ensureRuntimeEnvironmentCompatible } from './runtime-environment-compatibility'
export {
  ensureRuntimeEnvironmentCompatible,
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible,
  getRuntimeEnvironmentStatus,
  getRuntimeEnvironmentCapabilityStatus,
  runtimeEnvironmentSupportsCapability,
  assertRuntimeEnvironmentCapability,
  clearRuntimeCompatibilityCacheForTests
} from './runtime-environment-compatibility'

export { type RuntimeClientTarget } from './runtime-client-target'
export {
  hasRuntimeRpcErrorCode,
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-result'

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: {
    timeoutMs?: number
    suppressFeatureInteraction?: boolean
    reuseRecentCompatibilityFailure?: boolean
    skipCompatibilityCheck?: boolean
    signal?: AbortSignal
    expectedEnvironmentPairingRevision?: number
    expectedEnvironmentRuntimeId?: string
  } = {}
): Promise<TResult> {
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const expectedEnvironmentPairingRevision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(
          target.environmentId,
          options.expectedEnvironmentPairingRevision
        )
      : undefined
  if (
    target.kind === 'environment' &&
    method !== 'status.get' &&
    options.skipCompatibilityCheck !== true
  ) {
    await waitForPromiseWithSignal(
      ensureRuntimeEnvironmentCompatible(target.environmentId, {
        ...options,
        expectedEnvironmentPairingRevision
      }),
      options.signal
    )
  }
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const nextParams = options.suppressFeatureInteraction
    ? withBrowserPaneUiRuntimeRpcSource(params)
    : params
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params: nextParams })
      : await callRuntimeEnvironmentWithRevision({
          environmentId: target.environmentId,
          method,
          params: nextParams,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          expectedEnvironmentPairingRevision,
          expectedEnvironmentRuntimeId: options.expectedEnvironmentRuntimeId
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}
