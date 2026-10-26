import { errorMessage } from '../../shared/error-message'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import {
  WslDistroNotRunningError,
  WslOrcadLaunchDeferredError
} from './wsl-orcad-connection-errors'

/**
 * Liveness keeps reconnecting a running host whose connect failed, so a call that met the failure
 * reads as "not reachable yet" and retries instead of dead-ending its pane. Final: a deferred update
 * or unsupported distro (they wait on the user) and a no-boot refusal (the distro stopped, E9).
 */
export function retryableConnectFailure(distro: string, error: unknown): unknown {
  if (
    error instanceof WslOrcadLaunchDeferredError ||
    error instanceof OrcadHostUnsupportedError ||
    error instanceof WslDistroNotRunningError
  ) {
    return error
  }
  return new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    // Why this wording: subscriptions cross IPC as a message, and renderers match this phrase.
    `Could not connect to the remote Orca runtime in ${distro} yet: ${errorMessage(error)}`
  )
}

/** A `.catch` handler that rethrows a connect failure in its retryable-or-final form. */
export function rethrowRetryable(distro: string): (error: unknown) => never {
  return (error) => {
    throw retryableConnectFailure(distro, error)
  }
}
