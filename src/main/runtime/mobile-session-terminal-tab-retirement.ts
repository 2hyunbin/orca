import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'

/**
 * The snapshot without a closed terminal tab, or null unless every surface it lists for that tab
 * carries its own retirement proof.
 *
 * Why all-or-nothing: a paired client treats a terminal that vanishes without a proof as an orphan
 * to recover, so a surface with no proof stays listed until the window's own republish drops it.
 */
export function retireProvenTerminalTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  parentTabId: string,
  proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionTabsSnapshot | null {
  const surfaces = snapshot.tabs.filter(
    (tab): tab is RuntimeMobileSessionTerminalTab =>
      tab.type === 'terminal' && tab.parentTabId === parentTabId
  )
  let next: RuntimeMobileSessionTabsSnapshot | null = null
  for (const surface of surfaces) {
    const proof = proofs.find(
      (candidate) => candidate.parentTabId === parentTabId && candidate.leafId === surface.leafId
    )
    const retired = proof
      ? retireTerminalSurfacesFromSnapshot({
          snapshot: next ?? snapshot,
          ptyId: proof.ptyId,
          exactSurfaces: [surface],
          exactOnly: true,
          retirementProofs: [proof]
        })
      : null
    if (!retired) {
      return null
    }
    next = retired.snapshot
  }
  return next
}
