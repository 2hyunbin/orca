import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { terminalLayoutLeafIds } from '../web-session-terminal-orphan-recovery-surface-index'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'

type RetiredSurfaces = RuntimeMobileSessionTabsResult['retiredTerminalSurfaces']

/** A row the mirror keeps is the host's to retire once its close records cover every pane the row holds (#11800). */
export function isTerminalRowRetiredByHost(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  retired: RetiredSurfaces,
  environmentId: string
): boolean {
  if (!retired?.length || isMirroredTerminalSurfaceId(tab.id)) {
    return false
  }
  const retiredPtyIds = new Set(
    retired.map((surface) => toRemoteRuntimePtyId(surface.terminal, environmentId))
  )
  // A bound pane is identified by its PTY; an unbound one only by the host's tab and leaf ids.
  const isRetired = (leafId: string | null, ptyId: string | null | undefined): boolean =>
    ptyId
      ? retiredPtyIds.has(ptyId)
      : retired.some(
          (surface) =>
            surface.parentTabId === tab.id && (leafId === null || surface.leafId === leafId)
        )
  const leaves = terminalLayoutLeafIds(layout)
  if (leaves.length === 0) {
    return isRetired(null, tab.ptyId)
  }
  return leaves.every(({ leafId }) => isRetired(leafId, layout?.ptyIdsByLeafId?.[leafId]))
}
