// Why: under sustained writes watch batches can outpace slow (SSH/WSL) reads; restarting the
// read on every batch supersedes each result before it lands, so the tab never updates.
// Allow one watcher-triggered read per key and run exactly one follow-up with the latest change.

// Why: a read through a dead transport may never settle; don't let it block later reloads forever.
const STALE_WATCHER_READ_MS = 10_000

export type EditorWatcherReloadCoalescer = {
  run: (key: string, load: () => Promise<void>) => void
  dispose: () => void
}

type InFlightRead = { token: object; startedAt: number; replacedStale: boolean }

export function createEditorWatcherReloadCoalescer(): EditorWatcherReloadCoalescer {
  const inFlight = new Map<string, InFlightRead>()
  const pending = new Map<string, () => Promise<void>>()
  let disposed = false

  const start = (key: string, load: () => Promise<void>, replacedStale: boolean): void => {
    const token = {}
    inFlight.set(key, { token, startedAt: Date.now(), replacedStale })
    void load()
      .catch(() => {})
      .finally(() => {
        if (inFlight.get(key)?.token !== token) {
          return
        }
        inFlight.delete(key)
        const next = pending.get(key)
        pending.delete(key)
        if (next && !disposed) {
          start(key, next, false)
        }
      })
  }

  return {
    run(key, load) {
      if (disposed) {
        return
      }
      const current = inFlight.get(key)
      // Why: replace a stale read once; a read that is merely slow must be allowed to land.
      if (
        current &&
        (current.replacedStale || Date.now() - current.startedAt < STALE_WATCHER_READ_MS)
      ) {
        pending.set(key, load)
        return
      }
      pending.delete(key)
      start(key, load, current !== undefined)
    },
    dispose() {
      disposed = true
      pending.clear()
    }
  }
}
