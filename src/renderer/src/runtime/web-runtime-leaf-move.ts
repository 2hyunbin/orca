import type { TerminalLeafMoveRequest } from '../../../shared/terminal-leaf-move'
import { SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import {
  clearWebSessionReorderIntent,
  recordWebSessionReorderIntent
} from './web-session-reorder-intent'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { moveWebRuntimeSessionTab } from './web-runtime-session-tab-move'
import { activateWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'

/** The runtime that commits this worktree's pane moves itself; null keeps the move in this window. */
export async function resolvePaneMoveHost(worktreeId: string): Promise<string | null> {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    worktreeId,
    'move a pane to a new tab on its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return null
  }
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY
  ).catch(() => false)
  return supported ? environmentId : null
}

// Why: leaf-to-tab membership is host-authoritative for remote tabs; a local-only move reverts on the next snapshot.
/** True once the host committed the move; any other answer leaves the pane where the host had it. */
export async function moveWebRuntimeLeafToNewTab(
  environmentId: string,
  request: TerminalLeafMoveRequest
): Promise<boolean> {
  try {
    const response = await captureRuntimeEnvironmentCall(environmentId)({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: toRuntimeWorktreeSelector(request.worktreeId),
        sourceTabId: toHostSessionTabId(request.sourceTabId),
        targetTabId: toHostSessionTabId(request.targetTabId),
        leafId: request.leafId
      },
      timeoutMs: 15_000
    })
    const answer = unwrapRuntimeRpcResult(response)
    const moved =
      typeof answer === 'object' &&
      answer !== null &&
      'status' in answer &&
      answer.status === 'moved'
    if (!moved) {
      console.warn('[web-runtime-session] host did not move the pane', answer)
    }
    return moved
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to move pane to new tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

/** Where this window drew the moved pane's tab, read at the drop, before a host snapshot lands. */
export type DroppedPanePlacement = {
  /** The group and its order when the pane was dropped at a chosen position. */
  order: { groupId: string; tabOrder: string[] } | null
  active: boolean
}

/**
 * Reads the drop's placement and holds the drawn order, so the host's snapshot of the commit,
 * which goes out before its reply and appends the tab, cannot move it back meanwhile.
 */
export function holdDroppedPanePlacement(
  environmentId: string,
  request: TerminalLeafMoveRequest,
  placedInGroupId: string | null
): DroppedPanePlacement {
  const state = useAppStore.getState()
  const tabOrder = placedInGroupId
    ? state.groupsByWorktree[request.worktreeId]?.find((group) => group.id === placedInGroupId)
        ?.tabOrder
    : undefined
  const order =
    placedInGroupId && tabOrder?.includes(request.targetTabId)
      ? { groupId: placedInGroupId, tabOrder: [...tabOrder] }
      : null
  if (order) {
    recordWebSessionReorderIntent(
      captureWebSessionIntentOwner(environmentId),
      request.worktreeId,
      order.groupId,
      order.tabOrder,
      Date.now()
    )
  }
  return {
    order,
    active: state.activeTabIdByWorktree[request.worktreeId] === request.targetTabId
  }
}

/**
 * After the host answered: a refusal drops the held order and redraws the host's tabs so the pane
 * goes back at once; a committed move gives the host the drop position and focus held at the drop.
 */
export async function settleHostPaneMove(args: {
  environmentId: string
  request: TerminalLeafMoveRequest
  moved: boolean
  placement: DroppedPanePlacement
}): Promise<void> {
  const { environmentId, request, moved, placement } = args
  const { worktreeId, targetTabId } = request
  if (!moved) {
    if (placement.order) {
      clearWebSessionReorderIntent(
        captureWebSessionIntentOwner(environmentId),
        worktreeId,
        placement.order.groupId
      )
    }
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId)
    return
  }
  if (placement.order) {
    await moveWebRuntimeSessionTab({
      kind: 'reorder',
      worktreeId,
      environmentId,
      tabId: targetTabId,
      targetGroupId: placement.order.groupId,
      tabOrder: placement.order.tabOrder
    })
  }
  if (placement.active) {
    await activateWebRuntimeSessionTab({
      worktreeId,
      tabId: targetTabId,
      environmentId,
      expectedCurrentLocalTabId: targetTabId
    })
  }
}
