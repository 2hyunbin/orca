// Chains each sweep after the previous one settles, so a slow database never stacks them.
export function every(label: string, intervalMs: number, run: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void run()
        .catch((error: unknown) => {
          console.warn(
            JSON.stringify({
              event: 'orca_connector_sweep_failed',
              target: label,
              error: error instanceof Error ? error.name : 'unknown'
            })
          )
        })
        .finally(schedule)
    }, intervalMs)
    timer.unref()
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

const CHALLENGE_PRUNE_INTERVAL_MS = 60_000
const SESSION_PRUNE_INTERVAL_MS = 10 * 60_000
const SIGN_IN_PRUNE_INTERVAL_MS = 10 * 60_000
const SIGN_IN_RETENTION_MS = 24 * 60 * 60_000

export function startConnectorBackground(runtime: {
  challenges: { pruneExpired(): Promise<number> }
  sessions: { pruneExpired(): Promise<number> }
  signIns: { pruneFinished(retentionMs: number): Promise<number> }
}): () => void {
  const stops = [
    every('challenges', CHALLENGE_PRUNE_INTERVAL_MS, () => runtime.challenges.pruneExpired()),
    every('sessions', SESSION_PRUNE_INTERVAL_MS, () => runtime.sessions.pruneExpired()),
    every('sign_ins', SIGN_IN_PRUNE_INTERVAL_MS, () =>
      runtime.signIns.pruneFinished(SIGN_IN_RETENTION_MS)
    )
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
