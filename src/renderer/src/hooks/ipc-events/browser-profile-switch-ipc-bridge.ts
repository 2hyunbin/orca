import { destroyPersistentWebview } from '@/components/browser-pane/host-guest/webview-registry'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import {
  findBrowserTabWorktreeId,
  isBrowserWorkspaceOwnedByPairedServer
} from './browser-request-workspace-owner'

function pairedServerWorkspaceError(): string {
  return translate(
    'browser.request.pairedServerWorkspace',
    "This workspace runs on a paired server. Use that server's browser tabs."
  )
}

// `browser tab set-profile`: no layout command changes a browser tab's profile yet, so main still
// asks this window to switch it and remount its webviews.
export function registerBrowserProfileSwitchIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRequestTabSetProfile((data) => {
      try {
        const store = useAppStore.getState()
        const pageWorktreeId = findBrowserTabWorktreeId(store, data.browserPageId)
        if (pageWorktreeId && isBrowserWorkspaceOwnedByPairedServer(store, pageWorktreeId)) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: pairedServerWorkspaceError()
          })
          return
        }
        const owningWorkspace = Object.values(store.browserTabsByWorktree)
          .flat()
          .find((workspace) => {
            if (workspace.id === data.browserPageId) {
              return true
            }
            const pages = store.browserPagesByWorkspace[workspace.id] ?? []
            return pages.some((page) => page.id === data.browserPageId)
          })
        if (!owningWorkspace) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.0e3cf53060',
              'Browser tab {{value0}} not found',
              { value0: data.browserPageId }
            )
          })
          return
        }
        // Why: a workspace may host several browser pages; profile switch must tear down all sibling webviews, not just the IPC's.
        const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
        if (workspacePages.length > 0) {
          for (const page of workspacePages) {
            // Document previews use a fixed partition, so profile changes must preserve their guests.
            if (!page.docLocation) {
              destroyPersistentWebview(page.id)
            }
          }
        } else {
          destroyPersistentWebview(data.browserPageId)
        }
        store.switchBrowserTabProfile(owningWorkspace.id, data.profileId, data.sessionPartition)
        window.api.ui.replyTabSetProfile({ requestId: data.requestId })
      } catch (err) {
        window.api.ui.replyTabSetProfile({
          requestId: data.requestId,
          error: err instanceof Error ? err.message : 'Tab profile update failed'
        })
      }
    })
  )
}
