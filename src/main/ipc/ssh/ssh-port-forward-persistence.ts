import type { BrowserWindow } from 'electron'
import type { SavedPortForward } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'

function forwardKey(
  forward: Pick<SavedPortForward, 'localPort' | 'remoteHost' | 'remotePort'>
): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

/**
 * Saves the live forwards plus every saved one not live, so a forward a restart left unrestored
 * survives a later add or edit (#32484). `dropped` names the one forward the user removed or edited away.
 */
export function persistPortForwards(
  targetId: string,
  dropped?: Pick<SavedPortForward, 'localPort' | 'remoteHost' | 'remotePort'>
): void {
  const active = portForwardManager!.listForwards(targetId)
  const activeKeys = new Set(active.map(forwardKey))
  const droppedKey = dropped ? forwardKey(dropped) : null

  const existing = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  const unrestored = existing.filter(
    (pf) => !activeKeys.has(forwardKey(pf)) && forwardKey(pf) !== droppedKey
  )

  const saved: SavedPortForward[] = [
    ...active.map((f) => ({
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      label: f.label
    })),
    ...unrestored
  ]
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

/** Resolves true once every saved forward is live on this transport. */
export async function restorePortForwards(
  targetId: string,
  getMainWindow: () => BrowserWindow | null
): Promise<boolean> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target?.portForwards?.length) {
    return true
  }
  const conn = connectionManager!.getConnection(targetId)
  if (!conn) {
    return false
  }
  // Replaced transports can leave forwards holding local ports but reaching nothing.
  await portForwardManager!.closeStaleForwards(targetId, conn)
  const live = new Set(portForwardManager!.listForwards(targetId).map(forwardKey))
  let complete = true

  for (const saved of target.portForwards) {
    if (live.has(forwardKey(saved))) {
      continue
    }
    // Reconnect can replace the transport mid-loop; stop before adding stale listeners.
    if (connectionManager!.getConnection(targetId) !== conn) {
      return false
    }
    try {
      const entry = await portForwardManager!.addForward(
        targetId,
        conn,
        saved.localPort,
        saved.remoteHost,
        saved.remotePort,
        saved.label
      )
      // A concurrent disconnect swept older forwards; release this newly completed one too.
      if (connectionManager!.getConnection(targetId) !== conn) {
        await portForwardManager!.removeForwardAndWait(entry.id)
        return false
      }
    } catch (err) {
      complete = false
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwards(targetId)
  broadcastPortForwards(getMainWindow, targetId)
  return complete
}
