import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import {
  confirmHostPaneMovesInSnapshot,
  isPendingHostPaneMoveTarget
} from './pending-host-pane-moves'
import { useAppStore } from '../store'
import {
  isRemovedSnapshot,
  isValidReadySurface,
  surfaceKey,
  terminalLayoutLeafIds,
  terminalRowsBySurface
} from './web-session-terminal-orphan-recovery-surface-index'

/** The host tabs each ready terminal handle is published in. */
export function readyTabIdsByTerminalHandle(
  snapshot: RuntimeMobileSessionTabsResult
): Map<string, Set<string>> {
  const tabIdsByHandle = new Map<string, Set<string>>()
  for (const row of snapshot.tabs) {
    if (row.type === 'terminal' && isValidReadySurface(row) && row.terminal) {
      const tabIds = tabIdsByHandle.get(row.terminal) ?? new Set<string>()
      tabIds.add(row.parentTabId)
      tabIdsByHandle.set(row.terminal, tabIds)
    }
  }
  return tabIdsByHandle
}

/**
 * The host tab another client moved this binding's pane to: the snapshot names no row for the
 * binding but publishes its terminal live in another tab. This window's own move in flight waits
 * for the host, whose snapshot may predate it.
 */
export function hostTabPaneMovedTo(
  readyTabIds: ReadonlyMap<string, ReadonlySet<string>>,
  binding: { handle: string; hostTabId: string; localTabId: string; leafId: string }
): string | null {
  const movedTo = readyTabIds.get(binding.handle)
  if (!movedTo || movedTo.has(binding.hostTabId)) {
    return null
  }
  if (isPendingHostPaneMoveTarget(binding.localTabId, binding.leafId)) {
    return null
  }
  return movedTo.values().next().value ?? null
}

export type MovedPaneAuthority = { fromPaneKey: string; toPaneKey: string; ptyId: string }

/** Panes of this window another client moved to a new tab, named by their old and new pane keys. */
export function collectPanesMovedElsewhere(
  state: {
    tabsByWorktree: Readonly<Record<string, readonly { id: string }[] | undefined>>
    terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
  },
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): MovedPaneAuthority[] {
  if (isRemovedSnapshot(snapshot)) {
    return []
  }
  const readyTabIds = readyTabIdsByTerminalHandle(snapshot)
  const rowsBySurface = terminalRowsBySurface(snapshot)
  const moved: MovedPaneAuthority[] = []
  for (const localTab of state.tabsByWorktree[snapshot.worktree] ?? []) {
    if (!isWebTerminalSurfaceTabId(localTab.id)) {
      continue
    }
    const layout = state.terminalLayoutsByTabId[localTab.id]
    const hostTabId = toHostSessionTabId(localTab.id)
    for (const { leafId, offTree } of terminalLayoutLeafIds(layout)) {
      const ptyId = layout?.ptyIdsByLeafId?.[leafId]
      const remote = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
      if (offTree || !ptyId || remote?.environmentId !== environmentId) {
        continue
      }
      if (rowsBySurface.has(surfaceKey(hostTabId, leafId))) {
        continue
      }
      const target = hostTabPaneMovedTo(readyTabIds, {
        handle: remote.handle,
        hostTabId,
        localTabId: localTab.id,
        leafId
      })
      if (target) {
        moved.push({
          fromPaneKey: makePaneKey(localTab.id, leafId),
          toPaneKey: makePaneKey(toWebTerminalSurfaceTabId(target), leafId),
          ptyId
        })
      }
    }
  }
  return moved
}

/**
 * For a host snapshot this window accepted: a pane another client moved keeps its status, unread,
 * launch and sleeping records, as a local move's do, whether or not its source tab is mounted.
 */
export function transferPanesMovedInAcceptedSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): void {
  confirmHostPaneMovesInSnapshot(snapshot)
  // Why: read the bindings before this snapshot applies; transfer after, outside the store write.
  const moved = collectPanesMovedElsewhere(useAppStore.getState(), snapshot, environmentId)
  if (moved.length > 0) {
    queueMicrotask(() => {
      for (const transfer of moved) {
        useAppStore.getState().transferAgentPaneAuthority(transfer)
      }
    })
  }
}
