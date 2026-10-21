let outsideForeground = false
let foregroundLossRevision = 0

export function recordSocketDeadlineAppState(state: string | null | undefined): void {
  const nextOutsideForeground = state === 'background' || state === 'inactive'
  if (nextOutsideForeground && !outsideForeground) {
    foregroundLossRevision++
  }
  outsideForeground = nextOutsideForeground
}

export function startSocketDeadlineClock(): () => number {
  const armedWallMs = Date.now()
  const armedMonotonicMs = performance.now()
  const armedRevision = foregroundLossRevision
  const armedOutsideForeground = outsideForeground
  return () => {
    const monotonicElapsedMs = performance.now() - armedMonotonicMs
    const leftForeground = armedOutsideForeground || foregroundLossRevision !== armedRevision
    // Native monotonic clocks can pause during device sleep; wall time needs lifecycle evidence.
    return leftForeground
      ? Math.max(monotonicElapsedMs, Date.now() - armedWallMs)
      : monotonicElapsedMs
  }
}
