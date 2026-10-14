import { getSshTargetRegistryStore } from './ssh-target-registry'
import type { DirectSshAuthority } from '../../shared/ssh-types'
import { clearSshHostServerStatus } from './ssh-host-server-status'
import { isSshConnectionSolelyOwnedBy } from './ssh-connection-attribution'
import {
  connectInFlight,
  invalidateConnectAttempt,
  isCurrentConnectAttempt
} from '../ipc/ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from '../ipc/ssh-ipc-context'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { errorMessage } from '../../shared/error-message'
import { stopLegacyRelayBridge } from './legacy-relay-bridge/legacy-relay-bridge-registry'

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  await runTargetLifecycle(targetId, () => teardownSshTargetTransport(targetId))
}

export async function teardownSshTargetTransport(targetId: string): Promise<void> {
  // COMPAT(legacy-relay-bridge): hangs up only this client; the relays keep their terminals.
  stopLegacyRelayBridge(targetId)
  // Why first: local listeners must be released before disconnect completes, else an immediate
  // reconnect hits EADDRINUSE.
  const [forwards, disconnect] = await Promise.allSettled([
    portForwardManager?.removeAllForwards(targetId),
    (async () => connectionManager?.disconnect(targetId))()
  ])
  if (forwards.status === 'rejected') {
    throw forwards.reason
  }
  if (disconnect.status === 'rejected') {
    throw disconnect.reason
  }
}

/**
 * A cancelled connect, or one whose server decision failed, closes the transport its own decision
 * opened (a census, deploy or conversion), and only while nothing newer took it over: a completed
 * replacement connect or a managed tunnel adopts it, and a pending replacement may be about to.
 */
export async function abandonDecisionTransport(
  targetId: string,
  owner: symbol,
  authority: DirectSshAuthority
): Promise<void> {
  const opened = connectionManager!.getConnection(targetId)
  const newer = connectInFlight.get(targetId)
  // A pending replacement may be about to reuse it, though it has not adopted it yet. While this
  // attempt is still current the in-flight entry is its own, so nothing newer can exist.
  if (
    !opened ||
    !isSshConnectionSolelyOwnedBy(opened, owner) ||
    (newer &&
      isCurrentConnectAttempt(targetId, newer.authority) &&
      !isCurrentConnectAttempt(targetId, authority))
  ) {
    return
  }
  stopLegacyRelayBridge(targetId)
  try {
    await connectionManager!.disconnectConnection(targetId, opened)
  } catch (error) {
    // Why: the caller is about to throw the cancellation; a teardown throw must not replace it.
    console.warn(
      `[ssh] Failed to close the transport a cancelled decision opened for ${targetId}: ${errorMessage(error)}`
    )
  }
}

export async function removeSshTargetRegistration(
  targetId: string,
  clearBrowserData?: (targetId: string) => Promise<void>
): Promise<void> {
  const store = getSshTargetRegistryStore()
  if (!store) {
    return
  }
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  await runTargetLifecycle(targetId, async () => {
    try {
      await teardownSshTargetTransport(targetId)
    } catch (err) {
      // Why: a failed disconnect must not block metadata removal, else the target lingers in the store with uncleaned leases.
      console.warn(`[ssh] Failed to disconnect removed target ${targetId}: ${errorMessage(err)}`)
    }
    persistedStore?.removeSshRemotePtyLeases(targetId)
    store.removeTarget(targetId)
    if (clearBrowserData) {
      try {
        await clearBrowserData(targetId)
      } catch (error) {
        console.warn(
          `[ssh] Failed to clear browser partitions for removed target ${targetId}: ${errorMessage(error)}`
        )
      }
    }
  })
}
