import type { Session } from 'electron'
import { prepareBrowserRouteSessionPolicy } from '../browser/browser-route-session-policy'
import { PLUGIN_VIEWER_SCHEME, type PluginViewerSessionLease } from './plugin-viewer-session-pool'
import type { createPluginViewerDenyProxy } from './plugin-viewer-deny-proxy'

const securedSessions = new WeakSet<Session>()

export async function preparePluginViewerSession(input: {
  lease: PluginViewerSessionLease<Session>
  proxy: Awaited<ReturnType<typeof createPluginViewerDenyProxy>>
  getBootstrap(): string
  isCurrent(): boolean
}): Promise<void> {
  const { lease, proxy } = input
  if (!proxy.isAvailable()) {
    throw new Error('plugin_viewer_proxy_unavailable')
  }
  await prepareBrowserRouteSessionPolicy({
    partition: lease.partition,
    browserProfileId: 'plugin-viewer-private',
    proxyEndpoint: proxy.endpoint,
    dependencies: {
      getSession: () => lease.session,
      setupPolicies: () => {
        lease.session.webRequest.onBeforeRequest((details, callback) => {
          callback({
            cancel: !input.isCurrent() || !proxy.isAvailable() || details.url !== lease.url
          })
        })
        lease.session.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false)
        )
        lease.session.setPermissionCheckHandler(() => false)
        if (!securedSessions.has(lease.session)) {
          securedSessions.add(lease.session)
          lease.session.on('will-download', (event) => event.preventDefault())
        }
        lease.session.protocol.handle(PLUGIN_VIEWER_SCHEME, (request) => {
          if (
            request.method !== 'GET' ||
            request.url !== lease.url ||
            !input.isCurrent() ||
            !proxy.isAvailable()
          ) {
            return new Response(null, { status: 403 })
          }
          return new Response(input.getBootstrap(), {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-DNS-Prefetch-Control': 'off',
              'Content-Security-Policy':
                "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src data:; frame-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
            }
          })
        })
      },
      clearPolicies: () => lease.session.protocol.unhandle(PLUGIN_VIEWER_SCHEME)
    }
  })
  if (!proxy.isAvailable()) {
    throw new Error('plugin_viewer_proxy_unavailable')
  }
}

export async function clearPluginViewerSession(session: Session): Promise<void> {
  // Keep network and permission denial installed while the private slot is idle.
  session.protocol.unhandle(PLUGIN_VIEWER_SCHEME)
  await session.closeAllConnections()
  await session.clearStorageData()
  await session.clearCache()
}
