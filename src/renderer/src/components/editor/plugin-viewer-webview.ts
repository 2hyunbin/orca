import type { PluginViewerGuestLease } from '../../../../shared/plugins/plugin-viewer-open'
import {
  pluginViewerStatusSchema,
  type PluginViewerStatus
} from '../../../../shared/plugins/plugin-viewer-frame-protocol'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import {
  registerPersistentWebview,
  unregisterPersistentWebview,
  webviewRegistry
} from '../browser-pane/host-guest/webview-registry'

export function attachPluginViewerWebview(input: {
  container: HTMLDivElement
  identity: string
  lease: PluginViewerGuestLease
  label: string
  onStatus(status: PluginViewerStatus): void
}): () => void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron installs WebviewTag on webview elements in the desktop renderer.
  const webview = document.createElement('webview') as Electron.WebviewTag
  webview.setAttribute('partition', input.lease.partition)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('aria-label', input.label)
  webview.style.cssText = 'display:flex;width:100%;height:100%;border:0'
  const status = (event: Electron.IpcMessageEvent): void => {
    if (event.channel !== 'plugin-viewer:status' || event.args.length !== 1) {
      return
    }
    const parsed = pluginViewerStatusSchema.safeParse(event.args[0])
    if (parsed.success) {
      input.onStatus(parsed.data)
    }
  }
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined
  const stopUnavailable = window.api.plugins.onViewerUnavailable?.((event) => {
    if (event.leaseId === input.lease.id) {
      clearTimeout(unavailableTimer)
      input.onStatus({ type: 'error', code: event.code })
    }
  })
  const unavailable = (): void => {
    clearTimeout(unavailableTimer)
    // Let the main-owned failure reason arrive before the generic guest-destruction event.
    unavailableTimer = setTimeout(() => input.onStatus({ type: 'error', code: 'unavailable' }), 100)
  }
  const loadFailed = (event: Electron.DidFailLoadEvent): void => {
    if (event.isMainFrame && event.errorCode !== -3) {
      unavailable()
    }
  }
  webview.addEventListener('ipc-message', status)
  webview.addEventListener('render-process-gone', unavailable)
  webview.addEventListener('destroyed', unavailable)
  webview.addEventListener('did-fail-load', loadFailed)
  registerPersistentWebview(input.identity, webview)
  input.container.append(webview)
  webview.setAttribute('src', input.lease.url)
  return () => {
    stopUnavailable?.()
    clearTimeout(unavailableTimer)
    webview.removeEventListener('ipc-message', status)
    webview.removeEventListener('render-process-gone', unavailable)
    webview.removeEventListener('destroyed', unavailable)
    webview.removeEventListener('did-fail-load', loadFailed)
    webview.remove()
    if (webviewRegistry.get(input.identity) === webview) {
      unregisterPersistentWebview(input.identity)
    }
  }
}
