import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'
import {
  activateTerminalInitiatedWorktree,
  focusTerminalInitiatedTab
} from './terminal-command-state'

// Notification clicks: view-local presentation the runtime's navigate frame does not carry.
export function registerTerminalUiRoutingIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onFocusTerminal(
      ({
        tabId,
        worktreeId,
        leafId,
        ackPaneKeyOnSuccess,
        flashFocusedPane,
        scrollToBottomIfOutputSinceLastView
      }) => {
        const store = useAppStore.getState()
        activateTerminalInitiatedWorktree(store, worktreeId)
        store.setActiveTab(tabId)
        store.revealWorktreeInSidebar(worktreeId)
        if (ackPaneKeyOnSuccess || flashFocusedPane || scrollToBottomIfOutputSinceLastView) {
          activateTabAndFocusPane(tabId, leafId ?? null, {
            ...(ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess } : {}),
            ...(flashFocusedPane ? { flashFocusedPane: true } : {}),
            ...(scrollToBottomIfOutputSinceLastView
              ? { scrollToBottomIfOutputSinceLastView: true }
              : {})
          })
          return
        }
        focusTerminalInitiatedTab(tabId, leafId, worktreeId)
      }
    )
  )

  unsubs.push(
    window.api.ui.onFocusEditorTab(({ tabId, worktreeId, userInitiated }) => {
      const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
      const store = useAppStore.getState()
      const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (item) => item.id === localTabId
      )
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
      // Why: chat-completion focus is a courtesy reveal, not navigation — never yank the user
      // back into a workspace they deliberately left. A notification click is the opposite: the
      // user asked for this workspace, and the activateWorktree that precedes it is async, so
      // the active id here is still the old one and would swallow the reveal.
      if (
        !userInitiated &&
        tab?.contentType === 'agent-session' &&
        store.activeWorktreeId !== worktreeId
      ) {
        return
      }
      if (!tab) {
        if (browserTarget) {
          // Why: older/mobile fallback snapshots identify browser tabs by workspace id when no unified tab wrapper exists.
          store.setActiveWorktree(worktreeId)
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          store.setActiveBrowserTab(browserTarget.workspaceId)
          store.setActiveTabType('browser', worktreeId)
          store.revealWorktreeInSidebar(worktreeId)
        }
        return
      }
      store.setActiveWorktree(worktreeId)
      store.markWorktreeVisited(worktreeId)
      store.setActiveView('terminal')
      store.focusGroup(worktreeId, tab.groupId)
      store.activateTab(tab.id)
      if (tab.contentType === 'agent-session') {
        store.setActiveTabType('agent-session', worktreeId)
      } else if (browserTarget) {
        // Why: browser tabs need their own active-page state, not the editor file activation path.
        store.setActiveBrowserTab(browserTarget.workspaceId)
        store.setActiveTabType('browser', worktreeId)
      } else {
        store.setActiveFile(tab.entityId)
        store.setActiveTabType('editor', worktreeId)
      }
      store.revealWorktreeInSidebar(worktreeId)
    })
  )
}
