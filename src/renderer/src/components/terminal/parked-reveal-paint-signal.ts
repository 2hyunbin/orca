type Listener = () => void

const pendingByWorktree = new Map<string, number>()
const listeners = new Map<string, Set<Listener>>()

/**
 * Marks a parked tab remounting in this worktree. The returned settle (idempotent) runs once its
 * saved screens have parsed or the mount is torn down; the last one wakes listeners.
 */
export function beginParkedRevealPaint(worktreeId: string): () => void {
  pendingByWorktree.set(worktreeId, (pendingByWorktree.get(worktreeId) ?? 0) + 1)
  let settled = false
  return () => {
    if (settled) {
      return
    }
    settled = true
    const remaining = (pendingByWorktree.get(worktreeId) ?? 1) - 1
    if (remaining > 0) {
      pendingByWorktree.set(worktreeId, remaining)
      return
    }
    pendingByWorktree.delete(worktreeId)
    for (const listener of Array.from(listeners.get(worktreeId) ?? [])) {
      listener()
    }
  }
}

export function hasPendingParkedRevealPaint(worktreeId: string): boolean {
  return (pendingByWorktree.get(worktreeId) ?? 0) > 0
}

export function onParkedRevealPaintSettled(worktreeId: string, listener: Listener): () => void {
  let set = listeners.get(worktreeId)
  if (!set) {
    set = new Set()
    listeners.set(worktreeId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(worktreeId) === set) {
      listeners.delete(worktreeId)
    }
  }
}
