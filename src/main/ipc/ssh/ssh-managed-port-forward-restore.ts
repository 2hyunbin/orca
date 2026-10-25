import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { getSshHostServerStatus, isSshHostServed } from '../../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { restorePortForwards, savedPortForwardsAllLive } from './ssh-port-forward-persistence'

const changes = new Map<string, Promise<void>>()
/** The transport each host last restored on, so repeat triggers on it stay cheap. */
const restoredOn = new Map<
  string,
  { conn: SshConnection; generation: number; complete: boolean; at: number }
>()
// Per-call tunnel triggers would otherwise rebind a port that stays taken on every call.
const INCOMPLETE_RETRY_MS = 30_000

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
  if (!conn || last?.conn !== conn || last.generation !== conn.getConnectGeneration()) {
    return false
  }
  // A forward whose process exited since is missing again, so a full restore is not final.
  if (last.complete && savedPortForwardsAllLive(targetId)) {
    return true
  }
  return !last.complete && Date.now() - last.at < INCOMPLETE_RETRY_MS
}

export function restoreManagedHostPortForwards(
  targetId: string,
  options: ManagedHostPortForwardRestoreOptions = {}
): Promise<void> {
  if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
    return Promise.resolve()
  }
  return serializePortForwardChange(targetId, async () => {
    // A queued disconnect or edit may have changed the host while earlier work ran.
    if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
      return
    }
    const conn = connectionManager?.getConnection(targetId)
    const generation = conn?.getConnectGeneration()
    const complete = await restorePortForwards(targetId, getCurrentMainWindow)
    // A failed bind (e.g. a port briefly in use) is retried on the same transport, after a pause.
    if (conn && generation !== undefined && connectionManager?.getConnection(targetId) === conn) {
      restoredOn.set(targetId, { conn, generation, complete, at: Date.now() })
    }
  }).catch((error: unknown) => {
    console.warn(`[ssh] Could not restore port forwards for ${targetId}:`, error)
  })
}

/**
 * Runs one change to a host's forwards after every earlier one. Restores and user edits share it,
 * so a restore can't bind a saved port twice or reopen a mapping an edit is replacing.
 */
export function serializePortForwardChange<T>(
  targetId: string,
  change: () => Promise<T>
): Promise<T> {
  const previous = changes.get(targetId) ?? Promise.resolve()
  const result = previous.then(change)
  const settled = result.then(
    () => {},
    () => {}
  )
  changes.set(targetId, settled)
  void settled.finally(() => {
    if (changes.get(targetId) === settled) {
      changes.delete(targetId)
    }
  })
  return result
}
