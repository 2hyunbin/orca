import { useSyncExternalStore } from 'react'
import type { SpawnDeferralReason } from '../../../../shared/host-spawn-admission'

export type PaneSpawnDeferral = {
  reason: SpawnDeferralReason
  resume: () => void
}

// Why module state: the pane session is imperative and outlives renders; overlays only read it.
const deferralsByPaneKey = new Map<string, PaneSpawnDeferral>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setPaneSpawnDeferral(paneKey: string, deferral: PaneSpawnDeferral): void {
  deferralsByPaneKey.set(paneKey, deferral)
  notify()
}

export function clearPaneSpawnDeferral(paneKey: string): void {
  if (deferralsByPaneKey.delete(paneKey)) {
    notify()
  }
}

export function getPaneSpawnDeferral(paneKey: string): PaneSpawnDeferral | undefined {
  return deferralsByPaneKey.get(paneKey)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePaneSpawnDeferral(paneKey: string): PaneSpawnDeferral | undefined {
  return useSyncExternalStore(subscribe, () => deferralsByPaneKey.get(paneKey))
}
