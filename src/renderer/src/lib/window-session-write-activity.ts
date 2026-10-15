// Whether this window owes main a session write: one is scheduled or not yet acknowledged. Fed by
// the session write subscriber in a layout-owner build only; layout frames wait while it is busy,
// so a frame never replaces a change main has not received yet.

let busy = false
const idleListeners = new Set<() => void>()

export function reportWindowSessionWriteActivity(nextBusy: boolean): void {
  if (busy === nextBusy) {
    return
  }
  busy = nextBusy
  if (!busy) {
    for (const listener of idleListeners) {
      listener()
    }
  }
}

export function isWindowSessionWriteBusy(): boolean {
  return busy
}

export function onWindowSessionWriteIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}
