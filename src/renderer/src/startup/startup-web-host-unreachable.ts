import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebClient } from '../components/sidebar/worktree-card-model'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'

// The web connection waiter's own deadline message, which the shared classifier doesn't list.
const WEB_CONNECT_TIMEOUT_FRAGMENT = 'timed out while connecting to the remote orca runtime'

function isConnectionFailure(error: unknown): boolean {
  const like = toRemoteRuntimeClientErrorLike(error)
  return (
    isRecoverableRemoteRuntimeConnectionError(like) ||
    like.message.toLowerCase().includes(WEB_CONNECT_TIMEOUT_FRAGMENT)
  )
}

function hasReadyTransport(snapshots: readonly RuntimeHostStatusSnapshot[]): boolean {
  return snapshots.some((snapshot) => snapshot.transport === 'ready' && !snapshot.retired)
}

/**
 * On the paired web client the host *is* the catalog, so a host that isn't answering at boot fails
 * hydration even though nothing was half-applied. Only a connection failure while the transport is
 * still down counts; a failure on a ready socket is a genuine hydration fault.
 */
export async function isWebHostUnreachableAtStartup(error: unknown): Promise<boolean> {
  if (!isWebClient() || !isConnectionFailure(error)) {
    return false
  }
  try {
    const snapshots = (await window.api.runtimeEnvironments?.getStatusSnapshots?.()) ?? []
    return !hasReadyTransport(snapshots)
  } catch {
    return true
  }
}

/**
 * Says the host could not be reached (not that the session failed) and reloads into a clean
 * hydration once the transport, which keeps reconnecting on its own, is ready again.
 */
export function announceWebHostUnreachableAtStartup(): void {
  const reload = (): void => {
    void window.api.app.relaunch()
  }
  toast.error(translate('auto.startup.webHostUnreachable.title', "Couldn't reach your Orca host"), {
    description: translate(
      'auto.startup.webHostUnreachable.description',
      "Nothing was lost. Orca will reload when the host answers, and won't save changes until then."
    ),
    duration: Infinity,
    dismissible: true,
    action: {
      label: translate('auto.startup.webHostUnreachable.retry', 'Retry now'),
      onClick: reload
    }
  })
  let reloading = false
  let unsubscribe: (() => void) | undefined
  const reloadOnce = (snapshots: readonly RuntimeHostStatusSnapshot[]): void => {
    if (!reloading && hasReadyTransport(snapshots)) {
      reloading = true
      unsubscribe?.()
      reload()
    }
  }
  const statusApi = window.api.runtimeEnvironments
  unsubscribe = statusApi?.onStatusChanged?.((snapshot) => reloadOnce([snapshot]))
  // A reconnect that landed between the unreachable check and subscribing publishes nothing new.
  void statusApi
    ?.getStatusSnapshots?.()
    .then(reloadOnce)
    .catch(() => {})
}
