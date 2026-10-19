import type { RuntimeLeafRecord } from '../runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

export function traceE26GraphSync(
  previousLeaves: ReadonlyMap<string, RuntimeLeafRecord>,
  leaves: ReadonlyMap<string, RuntimeLeafRecord>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  windowId: unknown
): void {
  for (const [key, leaf] of leaves) {
    const prev = previousLeaves.get(key)
    if (!prev || prev.ptyId !== leaf.ptyId || prev.ptyGeneration !== leaf.ptyGeneration) {
      console.warn(`[e26] graph leaf ${key} pty ${prev?.ptyId ?? '-'}->${leaf.ptyId} gen ${prev?.ptyGeneration ?? '-'}->${leaf.ptyGeneration} t=${Date.now()}`)
    }
  }
  for (const key of previousLeaves.keys()) {
    if (!leaves.has(key)) {
      console.warn(`[e26] graph leaf removed ${key} t=${Date.now()}`)
    }
  }
  const tabs = [...snapshots.values()].flatMap((snap) =>
    snap.tabs.flatMap((t) => (t.type === 'terminal' ? [`${t.id}:${t.ptyId}`] : []))
  )
  console.warn(`[e26] graph sync win=${String(windowId)} mobileTerminalTabs=${JSON.stringify(tabs)} t=${Date.now()}`)
}
