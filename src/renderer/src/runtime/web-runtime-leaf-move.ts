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
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
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

/**
 * After the host answered: a refusal redraws the host's tabs so the pane goes back at once; a
 * committed move gives the host the drop position and the focus this window already shows.
 */
export async function settleHostPaneMove(args: {
  environmentId: string
  request: TerminalLeafMoveRequest
  moved: boolean
  /** The group the pane was dropped into at a chosen position, or null when appended. */
  placedInGroupId: string | null
}): Promise<void> {
  const { environmentId, request, moved, placedInGroupId } = args
  const { worktreeId, targetTabId } = request
  if (!moved) {
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId)
    return
  }
  const tabOrder = placedInGroupId
    ? useAppStore
        .getState()
        .groupsByWorktree[worktreeId]?.find((group) => group.id === placedInGroupId)?.tabOrder
    : undefined
  if (placedInGroupId && tabOrder?.includes(targetTabId)) {
    await moveWebRuntimeSessionTab({
      kind: 'reorder',
      worktreeId,
      environmentId,
      tabId: targetTabId,
      targetGroupId: placedInGroupId,
      tabOrder
    })
  }
  if (useAppStore.getState().activeTabIdByWorktree[worktreeId] === targetTabId) {
    await activateWebRuntimeSessionTab({
      worktreeId,
      tabId: targetTabId,
      environmentId,
      expectedCurrentLocalTabId: targetTabId
    })
  }
}
