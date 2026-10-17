import { e2eConfig } from '@/lib/e2e-config'

/**
 * One sidebar input main is taking over: what the window derives itself next to what main
 * publishes, keyed by workspace. Both reads cover the same scope; another producer's rows are
 * left out of both.
 */
export type SidebarShadowDomain<Value> = {
  name: string
  readWindow: () => ReadonlyMap<string, Value>
  /** Null when this host does not publish the domain (an older host). */
  readMain: () => Promise<{ revision: number; values: ReadonlyMap<string, Value> } | null>
  equals: (window: Value | undefined, main: Value | undefined) => boolean
}

export type SidebarShadowMismatch = {
  domain: string
  key: string
  window: unknown
  main: unknown
  mainRevision: number
}

/** One domain's comparison, with its value type closed over. */
export type SidebarShadowCheck = (
  record: (mismatch: SidebarShadowMismatch) => void
) => Promise<void>

const CHECK_INTERVAL_MS = 1_500

/**
 * Records settled disagreements only: a key is recorded once both sides held the same differing
 * values across a whole check interval, so propagation lag between window and main never counts.
 */
export function defineSidebarShadowDomain<Value>(
  domain: SidebarShadowDomain<Value>
): SidebarShadowCheck {
  let pending = new Map<string, string>()
  const recorded = new Set<string>()
  return async (record) => {
    const main = await domain.readMain()
    if (!main) {
      return
    }
    const window = domain.readWindow()
    const next = new Map<string, string>()
    for (const key of new Set([...window.keys(), ...main.values.keys()])) {
      const windowValue = window.get(key) ?? null
      const mainValue = main.values.get(key) ?? null
      if (domain.equals(window.get(key), main.values.get(key))) {
        continue
      }
      const signature = JSON.stringify([key, windowValue, mainValue, main.revision])
      next.set(key, signature)
      if (pending.get(key) === signature && !recorded.has(signature)) {
        recorded.add(signature)
        record({
          domain: domain.name,
          key,
          window: windowValue,
          main: mainValue,
          mainRevision: main.revision
        })
      }
    }
    pending = next
  }
}

/** Dev and test builds only; production never runs the comparison. */
export function installSidebarShadowComparison(checks: readonly SidebarShadowCheck[]): () => void {
  if (!(import.meta.env.DEV || e2eConfig.exposeStore) || typeof window === 'undefined') {
    return () => {}
  }
  const mismatches: SidebarShadowMismatch[] = []
  const record = (mismatch: SidebarShadowMismatch): void => {
    mismatches.push(mismatch)
    console.warn('[sidebar-shadow] window and main disagree', mismatch)
  }
  window.__sidebarShadow = {
    mismatchCount: () => mismatches.length,
    mismatches: () => [...mismatches]
  }
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) {
      return
    }
    inFlight = true
    void (async () => {
      for (const check of checks) {
        await check(record).catch((error: unknown) =>
          console.warn('[sidebar-shadow] check failed', error)
        )
      }
    })().finally(() => {
      inFlight = false
    })
  }, CHECK_INTERVAL_MS)
  return () => {
    clearInterval(timer)
    delete window.__sidebarShadow
  }
}
