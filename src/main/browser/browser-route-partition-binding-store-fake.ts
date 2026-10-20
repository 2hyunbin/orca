import { MAX_BINDING_ALIAS_FINGERPRINTS } from './browser-route-partition-binding-file'
import type { BrowserRoutePartitionBindingStore } from './browser-route-session-registry-contract'

type FakeBinding = { fingerprint: string; storageScope: string; aliasFingerprints?: string[] }

export type BrowserRoutePartitionBindingStoreFake = BrowserRoutePartitionBindingStore & {
  entries: Map<string, FakeBinding>
}

/** In-memory stand-in for the persisted binding store, for tests that only need its semantics. */
export function createBrowserRoutePartitionBindingStoreFake(): BrowserRoutePartitionBindingStoreFake {
  const entries = new Map<string, FakeBinding>()
  const holds = (entry: FakeBinding | undefined, fingerprint: string): boolean =>
    entry !== undefined &&
    (entry.fingerprint === fingerprint || (entry.aliasFingerprints ?? []).includes(fingerprint))
  return {
    entries,
    get: (partition) => entries.get(partition)?.fingerprint ?? null,
    set: (partition, fingerprint, storageScope) => {
      entries.set(partition, { fingerprint, storageScope })
      return []
    },
    touch: () => {},
    findPartitionByFingerprint: (fingerprint) => {
      const all = [...entries]
      const match =
        all.find(([, entry]) => entry.fingerprint === fingerprint) ??
        all.find(([, entry]) => holds(entry, fingerprint))
      return match?.[0] ?? null
    },
    holds: (partition, fingerprint) => holds(entries.get(partition), fingerprint),
    alias: (partition, fingerprint, storageScope) => {
      const entry = entries.get(partition)
      if (!entry) {
        throw new Error('browser_route_partition_binding_invalid')
      }
      const previous = (entry.aliasFingerprints ?? []).filter((alias) => alias !== fingerprint)
      entries.set(partition, {
        ...entry,
        storageScope,
        aliasFingerprints:
          entry.fingerprint === fingerprint
            ? previous
            : [fingerprint, ...previous].slice(0, MAX_BINDING_ALIAS_FINGERPRINTS)
      })
    }
  }
}
