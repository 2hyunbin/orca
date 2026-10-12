import type { BrowserWindow } from 'electron'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requestMobileMarkdownFromRenderer } from './mobile-markdown-request-relay'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'

let runtimeNotifierTokenCounter = 0
let activeRuntimeNotifierToken: number | null = null

export function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  const notifierToken = ++runtimeNotifierTokenCounter
  activeRuntimeNotifierToken = notifierToken
  runtime.attachWindow(mainWindow.id)
  const mainWebContents = mainWindow.webContents
  const rendererNotifications = createRuntimeRendererNotificationSender({
    isWindowDestroyed: () => mainWindow.isDestroyed(),
    webContents: mainWebContents,
    onFailure: (reason) => runtime.markGraphReloadFailed(mainWindow.id, reason)
  })
  const send = rendererNotifications.send
  runtime.setNotifier({
    worktreesChanged: (repoId, renamed, options) => {
      // Why: clear scan caches before the renderer handles this event, so it can't read stale TTL entries after a mutation.
      if (options?.invalidateGitScans !== false) {
        runWorktreeChangeInvalidators(repoId)
      }
      send('worktrees:changed', renamed ? { repoId, renamed } : { repoId })
    },
    worktreeBaseStatus: (event) => send('worktree:baseStatus', event),
    worktreeRemoteBranchConflict: (event) => send('worktree:remoteBranchConflict', event),
    reposChanged: () => send('repos:changed'),
    automationsChanged: (payload) => send('automations:changed', payload),
    readMobileMarkdownTab: (worktreeId, tabId) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'read',
        worktreeId,
        tabId
      }) as Promise<RuntimeMarkdownReadTabResult>,
    saveMobileMarkdownTab: (worktreeId, tabId, baseVersion, content) =>
      requestMobileMarkdownFromRenderer(mainWindow, {
        operation: 'save',
        worktreeId,
        tabId,
        baseVersion,
        content
      }) as Promise<RuntimeMarkdownSaveTabResult>,
    sleepWorktree: (worktreeId) => send('ui:sleepWorktree', { worktreeId }),
    resumeSleepingAgents: (worktreeId) => send('ui:resumeSleepingAgents', { worktreeId }),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) =>
      send('runtime:terminalFitOverrideChanged', { ptyId, mode, cols, rows }),
    terminalDriverChanged: (ptyId, driver) =>
      send('runtime:terminalDriverChanged', { ptyId, driver }),
    nativeChatLaunchDraftResolved: (tabId, resolution) =>
      send('runtime:nativeChatLaunchDraftResolved', { tabId, ...resolution }),
    browserDriverChanged: (browserPageId, driver) =>
      send('runtime:browserDriverChanged', { browserPageId, driver }),
    browserRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
      send('runtime:browserRemoteViewersChanged', { browserPageId, hasRemoteViewers }),
    clientHostedBrowserRowsChanged: (event) => send('runtime:clientHostedBrowserRowsChanged', event)
  })
  registerRendererDocumentNavigation(mainWebContents, () => {
    rendererNotifications.onMainFrameReloadStarted()
    const fence = runtime.markRendererReloading(mainWindow.id)
    return () => {
      if (fence && runtime.markRendererReloadCancelled(mainWindow.id, fence)) {
        rendererNotifications.onMainFrameReloadCancelled()
      }
    }
  })
  mainWebContents.on('did-finish-load', () => {
    rendererNotifications.onMainFrameLoadFinished()
  })
  mainWebContents.on('render-process-gone', () => {
    rendererNotifications.onRendererProcessGone()
  })
  mainWindow.on('closed', () => {
    rendererNotifications.close()
    runtime.markGraphUnavailable(mainWindow.id)
    if (activeRuntimeNotifierToken === notifierToken) {
      // Why: the notifier closes over the window; clear it in the no-window gap so the runtime can't retain destroyed graphs.
      runtime.setNotifier(null)
      activeRuntimeNotifierToken = null
    }
  })
}
