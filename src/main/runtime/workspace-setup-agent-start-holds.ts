// A chat created with a workspace whose project waits for setup starts its agent once setup ends.
//
// The hold is the setup completion observation itself, kept only in memory and bounded by the same
// timeout the launch's own wait had: setup that fails, hangs or outlives the host never strands a
// start, it only stops delaying it.

const SETUP_WAIT_TIMEOUT_MS = 60_000

/** Waits for setup to end; settles either way, and stops when `signal` aborts. */
export type WorkspaceSetupCompletion = (signal: AbortSignal) => Promise<unknown>

export class WorkspaceSetupAgentStartHolds {
  private readonly held = new Map<string, Promise<void>>()

  /** Holds agent starts in the workspace from now; `release` names what ends the hold, if anything. */
  hold(worktreeId: string): (completion: WorkspaceSetupCompletion | null) => void {
    const ended = new AbortController()
    const timer = setTimeout(
      () => ended.abort(new Error('setup_wait_timeout')),
      SETUP_WAIT_TIMEOUT_MS
    )
    timer.unref?.()
    const released = new Promise<void>((resolve) => {
      ended.signal.addEventListener('abort', () => resolve(), { once: true })
    }).finally(() => {
      clearTimeout(timer)
      if (this.held.get(worktreeId) === released) {
        this.held.delete(worktreeId)
      }
    })
    this.held.set(worktreeId, released)
    return (completion) => {
      if (!completion) {
        ended.abort()
        return
      }
      void completion(ended.signal)
        .catch(() => undefined)
        .then(() => ended.abort())
    }
  }

  /** What an agent start in the workspace waits on first; null when nothing holds it. */
  pending(worktreeId: string): Promise<void> | null {
    return this.held.get(worktreeId) ?? null
  }
}
