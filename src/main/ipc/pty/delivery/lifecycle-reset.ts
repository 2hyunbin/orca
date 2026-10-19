import type { PtyRendererDelivery } from '../session'
import {
  didFinishLoadHandler,
  didFinishLoadWebContents,
  rendererDidNavigateHandler,
  rendererDidStartNavigationHandler,
  rendererLifecycleResetHandler,
  rendererLifecycleResetWebContents,
  setDidFinishLoadHandler,
  setRendererLifecycleResetState
} from '../provider/listener-lifecycle'
import {
  noteRendererNavigationCommit,
  noteRendererNavigationStart,
  retireCurrentRendererPage
} from './renderer-page'
import { mainDeliveryBreadcrumbs, resetRendererDeliveryAccountingForLifecycleReset } from './debug'
import { activeRendererPtys, invalidatePendingPtyDrainPriority } from './visibility-state'

export function clearDidFinishLoadHandler(): void {
  if (didFinishLoadHandler && didFinishLoadWebContents) {
    didFinishLoadWebContents.removeListener('did-finish-load', didFinishLoadHandler)
  }
  setDidFinishLoadHandler(null, null)
}

export function markRendererPtysHiddenForRendererLifecycleReset(): void {
  // A reload/crash in the breadcrumb history is load-bearing context for any freeze report.
  mainDeliveryBreadcrumbs.record('renderer-lifecycle-reset')
  // Why: renderer scheduling hints die with the page; its attachments end at commit, crash or destroy.
  const activePriorityChanged = activeRendererPtys.size > 0
  activeRendererPtys.clear()
  // Why: the dead page never ACKs its in-flight bytes, so leaked accounting would delivery-gate surviving PTYs forever after a reload/crash.
  resetRendererDeliveryAccountingForLifecycleReset()
  if (activePriorityChanged) {
    invalidatePendingPtyDrainPriority()
  }
}

export function clearRendererLifecycleResetHandlers(): void {
  if (!rendererLifecycleResetWebContents) {
    return
  }
  if (rendererDidStartNavigationHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'did-start-navigation',
      rendererDidStartNavigationHandler
    )
  }
  if (rendererDidNavigateHandler) {
    rendererLifecycleResetWebContents.removeListener('did-navigate', rendererDidNavigateHandler)
  }
  if (rendererLifecycleResetHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'render-process-gone',
      rendererLifecycleResetHandler
    )
    rendererLifecycleResetWebContents.removeListener('destroyed', rendererLifecycleResetHandler)
  }
  setRendererLifecycleResetState({ contents: null, handler: null, navigation: null, commit: null })
}

export function registerRendererLifecycleResetHandlers(
  webContents?: PtyRendererDelivery['webContents']
): void {
  clearRendererLifecycleResetHandlers()
  markRendererPtysHiddenForRendererLifecycleReset()
  if (!webContents) {
    return
  }
  const handler = (): void => {
    markRendererPtysHiddenForRendererLifecycleReset()
    retireCurrentRendererPage()
  }
  const navigationHandler = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    markRendererPtysHiddenForRendererLifecycleReset()
    noteRendererNavigationStart()
  }
  // Why did-navigate: only a main-frame commit ends the old document; a cancelled navigation keeps it.
  const commitHandler = (): void => noteRendererNavigationCommit()
  setRendererLifecycleResetState({
    contents: webContents,
    handler,
    navigation: navigationHandler,
    commit: commitHandler
  })
  webContents.on('did-start-navigation', navigationHandler)
  webContents.on('did-navigate', commitHandler)
  webContents.on('render-process-gone', handler)
  webContents.on('destroyed', handler)
}
