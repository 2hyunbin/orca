import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'

/** After local activation, notify the paired owner to store this client’s selection and wake parked panes. Focus late-arriving tabs unless navigation changed meanwhile. Local/direct-SSH workspaces need no owner round trip. */
export function activateTerminalTabOnOwner(
  worktreeId: string,
  tabId: string,
  leafId: string | null
): void {
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return
  }
  void activateWebRuntimeSessionTab({
    worktreeId,
    tabId,
    environmentId,
    leafId,
    expectedCurrentLocalTabId: resolveWebSessionVisibleTabId(state, worktreeId)
  })
}

/** Keyboard switches must reach the owner like clicks, or a server workspace reopens on its stale pick. */
export function activateTerminalTabAtActiveLeafOnOwner(
  worktreeId: string | null,
  tabId: string
): void {
  if (worktreeId) {
    const leafId = useAppStore.getState().terminalLayoutsByTabId?.[tabId]?.activeLeafId ?? null
    activateTerminalTabOnOwner(worktreeId, tabId, leafId)
  }
}

/** A browser tab the owner hosts; its selection must follow local activation like a terminal's. */
export function activateBrowserTabOnOwner(
  worktreeId: string,
  unifiedTabId: string,
  browserWorkspaceId: string
): void {
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (
    !environmentId ||
    !isWebRuntimeSessionActive(environmentId) ||
    !browserWorkspaceHasRemoteOwner(state, browserWorkspaceId, environmentId)
  ) {
    return
  }
  void activateWebRuntimeSessionTab({ worktreeId, tabId: unifiedTabId, environmentId })
}
