import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { getSshHostServerStatus, isSshHostServed } from '../../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { restorePortForwards } from './ssh-port-forward-persistence'

const restoring = new Map<string, Promise<void>>()
/** The transport each host last restored on; a status note or call on the same one restores nothing new. */
const restoredOn = new Map<string, { conn: SshConnection; generation: number }>()

export type ManagedHostPortForwardRestoreOptions = {
  /** The managed server's tunnel is up, which proves the host is served even before a status lands. */
  tunnelUp?: boolean
}

function mayRestore(targetId: string, options: ManagedHostPortForwardRestoreOptions): boolean {
  const status = getSshHostServerStatus(targetId)
  // Unsettled hosts may still tear the transport down for a deploy or conversion.
  return isSshHostServed(status) || (options.tunnelUp === true && status === undefined)
}

function alreadyRestored(targetId: string): boolean {
  const conn = connectionManager?.getConnection(targetId)
  const last = restoredOn.get(targetId)
  return !!conn && last?.conn === conn && last.generation === conn.getConnectGeneration()
}

export function restoreManagedHostPortForwards(
  targetId: string,
  options: ManagedHostPortForwardRestoreOptions = {}
): Promise<void> {
  if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
    return Promise.resolve()
  }
  // Serialize restores so concurrent connects cannot bind the same saved port twice.
  const previous = restoring.get(targetId) ?? Promise.resolve()
  const next = previous
    // A queued disconnect may have changed managed status while the previous restore ran.
    .then(async () => {
      if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
        return
      }
      const conn = connectionManager?.getConnection(targetId)
      const generation = conn?.getConnectGeneration()
      await restorePortForwards(targetId, getCurrentMainWindow)
      if (conn && generation !== undefined && connectionManager?.getConnection(targetId) === conn) {
        restoredOn.set(targetId, { conn, generation })
      }
    })
    .catch((error: unknown) => {
      console.warn(`[ssh] Could not restore port forwards for ${targetId}:`, error)
    })
    .finally(() => {
      if (restoring.get(targetId) === next) {
        restoring.delete(targetId)
      }
    })
  restoring.set(targetId, next)
  return next
}
