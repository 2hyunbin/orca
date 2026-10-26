import { createNonSecureContextUuid } from '../../../shared/non-secure-context-uuid'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export type RuntimeRpcSubscriptionHandlers = {
  /** Each successful frame's result. */
  onEvent: (result: unknown) => void
  onError: (error: unknown) => void
  /** Only a remote transport reports its own close; the local stream ends with a frame. */
  onClose: () => void
  signal?: AbortSignal
}

/** The streaming counterpart of `callRuntimeRpc`: the same method over either transport. */
export async function subscribeRuntimeRpc(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  handlers: RuntimeRpcSubscriptionHandlers
): Promise<{ unsubscribe: () => void }> {
  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      handlers.onError(response.error)
      return
    }
    handlers.onEvent(response.result)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method, params }, onResponse)
  }
  const subscriptionId = createNonSecureContextUuid()
  const cancel = (): void => {
    void window.api.runtimeEnvironments.cancelSubscription({ subscriptionId }).catch((error) => {
      console.warn('[runtime-subscription] setup cancellation failed', error)
    })
  }
  if (handlers.signal?.aborted) {
    throw new Error('Runtime subscription setup cancelled')
  }
  handlers.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const handle = await subscribeRuntimeEnvironment(
      {
        ...(handlers.signal ? { subscriptionId } : {}),
        selector: target.environmentId,
        method,
        params,
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
      },
      { onResponse, onError: handlers.onError, onClose: handlers.onClose }
    )
    if (handlers.signal?.aborted) {
      handle.unsubscribe()
      throw new Error('Runtime subscription setup cancelled')
    }
    return handle
  } finally {
    handlers.signal?.removeEventListener('abort', cancel)
  }
}
