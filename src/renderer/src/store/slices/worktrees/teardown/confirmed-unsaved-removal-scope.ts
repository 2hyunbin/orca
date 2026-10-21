import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

const scopes = new Map<string, number>()

export function beginConfirmedUnsavedRemoval(
  hostId: ExecutionHostId | undefined,
  id: string
): () => void {
  if (!hostId) {
    return () => {}
  }
  const key = composeWorktreeHostIdentity(hostId, id)
  scopes.set(key, (scopes.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (scopes.get(key) ?? 1) - 1
    if (remaining === 0) {
      scopes.delete(key)
    } else {
      scopes.set(key, remaining)
    }
  }
}

export function isUnsavedRemovalConfirmed(
  hostId: ExecutionHostId | undefined,
  id: string
): boolean {
  return hostId !== undefined && scopes.has(composeWorktreeHostIdentity(hostId, id))
}
