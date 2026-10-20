import { useEffect } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { isPairedWebClientWindow } from './desktop-window-chrome'
import { createBrowserUuid } from './browser-uuid'

/**
 * Switch point. Tells main the list mounted, so main's sleeping retention starts cold as the
 * window's does. A paired web client's list is its own view and never resets the host's.
 */
export function useSidebarListSession(): void {
  useEffect(() => {
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN || isPairedWebClientWindow()) {
      return
    }
    void window.api.runtime
      .call({ method: 'sidebarSession.begin', params: { sessionId: createBrowserUuid() } })
      .catch(() => {})
  }, [])
}

/**
 * Switch point. The window's own sleep stops PTYs without main's sleep map, so main hears which
 * workspaces it holds asleep. Sent before any kill, so main never mistakes the exits for a rebind.
 */
export function reportWindowSleptWorkspaces(worktreeIds: readonly string[]): void {
  // Store tests run the sleep flow without a window bridge.
  const runtime = typeof window === 'undefined' ? undefined : window.api?.runtime
  if (
    !ORCA_SIDEBAR_INPUTS_IS_MAIN ||
    isPairedWebClientWindow() ||
    typeof runtime?.call !== 'function'
  ) {
    return
  }
  void Promise.resolve(
    runtime.call({
      method: 'sidebarSession.sleptWorkspaces',
      params: { worktreeIds: [...worktreeIds] }
    })
  ).catch(() => {})
}
