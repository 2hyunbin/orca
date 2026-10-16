import { useEffect, useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { isTabPaneTreeHeld, onTabPaneTreeRelease } from '@/runtime/layout-owner-pane-intents'
import { isHostAuthoritativeLayout } from './terminal-live-layout-reconciliation'
import { reconcileMountedPanesToLayout } from './terminal-pane-frame-reconciliation'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

/**
 * A layout-owner build's mounted local tab follows main's pane tree, which frames write to the
 * store. A paired server's tab keeps the host-authoritative reconciler; a tab the window's own
 * command holds waits for that command's answer.
 */
export function useLayoutOwnerPaneTree(controller: TerminalPaneCloseController): void {
  const {
    closePaneLocally,
    expandedPaneIdRef,
    isolatedPaneKey,
    managerRef,
    persistLayoutSnapshot,
    restoredLayout,
    tabId
  } = controller
  const [releases, setReleases] = useState(0)
  useEffect(
    () =>
      onTabPaneTreeRelease((releasedTabId) => {
        if (releasedTabId === tabId) {
          setReleases((count) => count + 1)
        }
      }),
    [tabId]
  )
  useEffect(() => {
    const manager = managerRef.current
    if (
      !manager ||
      isTabPaneTreeHeld(tabId) ||
      isHostAuthoritativeLayout({
        isWebClient: isWebClientLocation(),
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const changed = reconcileMountedPanesToLayout({
      tabId,
      manager,
      layout: restoredLayout,
      closePane: (paneId, leafId, kind) => {
        if (kind === 'user') {
          closePaneLocally(paneId, leafId)
        } else {
          // An exited pane closes as the window's exit path closes it: no user-close clean-up.
          manager.closePane(paneId)
        }
      },
      isExpanded: expandedPaneIdRef.current !== null || isolatedPaneKey !== null
    })
    if (changed) {
      persistLayoutSnapshot()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Refs and stable callbacks.
  }, [restoredLayout, releases, isolatedPaneKey, tabId])
}
