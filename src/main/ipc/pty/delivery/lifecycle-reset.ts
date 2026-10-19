import type { PtyRendererDelivery } from '../session'
import {
  didFinishLoadHandler,
  didFinishLoadWebContents,
  rendererDidStartNavigationHandler,
  rendererLifecycleResetHandler,
  rendererLifecycleResetWebContents,
  setDidFinishLoadHandler,
  setRendererLifecycleResetState
} from '../provider/listener-lifecycle'
import { retireRendererPages } from './renderer-page'
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
  // Renderer scheduling hints reset independently of document transport ownership.
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
  if (rendererLifecycleResetHandler) {
    rendererLifecycleResetWebContents.removeListener(
      'render-process-gone',
      rendererLifecycleResetHandler
    )
    rendererLifecycleResetWebContents.removeListener('destroyed', rendererLifecycleResetHandler)
  }
  setRendererLifecycleResetState({ contents: null, handler: null, navigation: null })
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
    retireRendererPages(webContents)
  }
  const navigationHandler = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    markRendererPtysHiddenForRendererLifecycleReset()
  }
  setRendererLifecycleResetState({
    contents: webContents,
    handler,
    navigation: navigationHandler
  })
  webContents.on('did-start-navigation', navigationHandler)
  webContents.on('render-process-gone', handler)
  webContents.on('destroyed', handler)
}
