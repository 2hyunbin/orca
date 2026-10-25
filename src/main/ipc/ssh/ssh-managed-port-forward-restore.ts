import { getSshHostServerStatus, isSshHostServed } from '../../ssh/ssh-host-server-status'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { restorePortForwards } from './ssh-port-forward-persistence'

const restoring = new Map<string, Promise<void>>()

export function restoreManagedHostPortForwards(targetId: string): Promise<void> {
  // Unsettled hosts may still tear the transport down for a deploy or conversion.
  if (!isSshHostServed(getSshHostServerStatus(targetId))) {
    return Promise.resolve()
  }
  // Serialize restores so concurrent connects cannot bind the same saved port twice.
  const previous = restoring.get(targetId) ?? Promise.resolve()
  const next = previous
    // A queued disconnect may have changed managed status while the previous restore ran.
    .then(() =>
      isSshHostServed(getSshHostServerStatus(targetId))
        ? restorePortForwards(targetId, getCurrentMainWindow)
        : undefined
    )
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
