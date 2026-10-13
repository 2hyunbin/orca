import { app, BrowserWindow, protocol, session, WebContentsView, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { z } from 'zod'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { startPluginViewerGuestWatchdog } from './plugin-viewer-guest-watchdog'
import { pluginViewerWorkerProbePage } from './plugin-viewer-worker-probe-page'
import { pluginViewerRuntimeProbePage } from './plugin-viewer-runtime-probe-page'
import { createViewerRuntimeProbeTransport } from './plugin-viewer-runtime-probe-transport'
import { probePluginViewerSessionPool } from './plugin-viewer-session-pool-probe'
import { PLUGIN_VIEWER_SCHEME } from './plugin-viewer-session-pool'

const configSchema = z.strictObject({
  resultPath: z.string(),
  netLogPath: z.string(),
  runtimeScriptPath: z.string(),
  runtimePreloadPath: z.string(),
  viewerPreloadPath: z.string(),
  documentPath: z.string()
})

protocol.registerSchemesAsPrivileged([
  { scheme: PLUGIN_VIEWER_SCHEME, privileges: { standard: true, secure: true } },
  {
    scheme: 'orca-viewer-probe',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])
applyBackgroundActivationPolicy()
app.on('window-all-closed', () => {})

async function run(): Promise<void> {
  if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
    throw new Error('background launch required')
  }
  const config = configSchema.parse(JSON.parse(await readFile(process.argv[2], 'utf8')))
  const timeout = setTimeout(() => app.exit(2), 30_000)
  await app.whenReady()
  const host = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: config.runtimePreloadPath,
      backgroundThrottling: false
    }
  })
  const guestSession = session.fromPartition(`viewer-probe-${randomUUID()}`, { cache: false })
  const sockets = new Set<Socket>()
  const closedProxy = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.destroy()
  })
  const proxyPort = await new Promise<number>((resolve, reject) => {
    closedProxy.once('error', reject)
    closedProxy.listen(0, '127.0.0.1', () => {
      const address = closedProxy.address()
      if (!address || typeof address === 'string') {
        return reject(new Error('proxy unavailable'))
      }
      resolve(address.port)
    })
  })
  await guestSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: `socks5://127.0.0.1:${proxyPort}`,
    proxyBypassRules: '<-loopback>'
  })
  await guestSession.closeAllConnections()
  const resolvedProxy = await guestSession.resolveProxy('https://viewer-proxy-check.invalid/')
  guestSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('orca-viewer-probe://viewer/') })
  })
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  guestSession.setPermissionCheckHandler(() => false)
  guestSession.on('will-download', (event) => event.preventDefault())
  const guest = new WebContentsView({
    webPreferences: {
      session: guestSession,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: ['--blink-settings=dnsPrefetchingEnabled=false'],
      preload: config.runtimePreloadPath,
      backgroundThrottling: false
    }
  })
  guest.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  host.contentView.addChildView(guest)
  guest.setBounds({ x: 0, y: 100, width: 800, height: 450 })
  await host.loadURL(
    `data:text/html,${encodeURIComponent('<h1>Viewer isolation probe</h1><p id="counter">0</p>')}`
  )
  const prefix = `viewer-${randomUUID()}`
  const hosts = {
    control: `${prefix}-control.invalid`,
    protectedTop: `${prefix}-top.invalid`,
    protectedChild: `${prefix}-child.invalid`,
    workerNetwork: `${prefix}-worker.invalid`,
    neverRequested: `${prefix}-unused.invalid`
  }
  let page = '<h1>Host-owned viewer bootstrap</h1>'
  let disableDnsPrefetch = false
  guestSession.protocol.handle('orca-viewer-probe', () => {
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; frame-src 'self' data:; connect-src 'none'; object-src 'none'"
    })
    if (disableDnsPrefetch) {
      headers.set('X-DNS-Prefetch-Control', 'off')
    }
    return new Response(`<!doctype html>${page}`, { headers })
  })
  await guestSession.netLog.startLogging(config.netLogPath)
  const load = async (html: string, off: boolean): Promise<void> => {
    page = html
    disableDnsPrefetch = off
    await guest.webContents.loadURL('orca-viewer-probe://viewer/')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  const controlSession = session.fromPartition(`viewer-control-${randomUUID()}`, { cache: false })
  await controlSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: `socks5://127.0.0.1:${proxyPort}`,
    proxyBypassRules: '<-loopback>'
  })
  controlSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('orca-viewer-probe://viewer/') })
  })
  controlSession.protocol.handle(
    'orca-viewer-probe',
    () =>
      new Response(`<link rel="dns-prefetch" href="https://${hosts.control}">`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
  )
  const control = new WebContentsView({
    webPreferences: {
      session: controlSession,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  await control.webContents.loadURL('orca-viewer-probe://viewer/')
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  control.webContents.close({ waitForBeforeUnload: false })
  controlSession.protocol.unhandle('orca-viewer-probe')
  const attack = (hostname: string) =>
    `<meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="https://${hostname}">`
  await load(`${attack(hosts.protectedTop)}<h1>Top-level opt-in attempt</h1>`, true)
  await load(
    `<iframe sandbox="allow-scripts" srcdoc='${attack(hosts.protectedChild)}'></iframe>`,
    true
  )
  await load(pluginViewerWorkerProbePage(hosts.workerNetwork), true)
  const workerProof: unknown = await guest.webContents.executeJavaScript('globalThis.workerProof')
  const workerTerminated: unknown = await guest.webContents.executeJavaScript(
    'globalThis.workerTerminated'
  )
  const workerError: unknown = await guest.webContents.executeJavaScript('globalThis.workerError')
  await load('<h1>Host-owned viewer bootstrap</h1>', true)
  const runtime = await createViewerRuntimeProbeTransport(guest.webContents, config.documentPath)
  const forgedRead: unknown = await host.webContents.executeJavaScript(
    `viewerProbe.read(${JSON.stringify({
      documentHandle: runtime.document.documentHandle,
      revision: runtime.document.revision,
      position: 0,
      length: 1
    })})`
  )
  await load(
    pluginViewerRuntimeProbePage(
      await readFile(config.runtimeScriptPath, 'utf8'),
      runtime.document,
      { version: 1, sessionId: randomUUID(), generation: 1 }
    ),
    true
  )
  const runtimeProof: unknown = await guest.webContents
    .executeJavaScript(`new Promise((resolve) => {
    const until = Date.now() + 5000;
    const read = () => {
      if (globalThis.runtimeProof || Date.now() >= until) resolve(globalThis.runtimeProof);
      else setTimeout(read, 50);
    };
    read();
  })`)
  const runtimeReads = runtime.reads
  await runtime.dispose()
  await load('<h1>Host-owned viewer bootstrap</h1>', true)
  await guestSession.netLog.stopLogging()
  const hostPid = host.webContents.getOSProcessId()
  const guestPid = guest.webContents.getOSProcessId()
  const recovery = new Promise<string>((resolve) => {
    startPluginViewerGuestWatchdog(guest.webContents, {
      getPeerContents: () => webContents.getAllWebContents(),
      onUnavailable: resolve
    })
  })
  const started = Date.now()
  void guest.webContents
    .executeJavaScript("document.body.textContent = 'Busy viewer'; while (true) {}")
    .catch(() => undefined)
  let hostReplies = 0
  for (let index = 0; index < 4; index++) {
    const value: unknown = await host.webContents.executeJavaScript(
      "document.querySelector('#counter').textContent = String(Number(document.querySelector('#counter').textContent) + 1)"
    )
    if (value === String(index + 1)) {
      hostReplies++
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const reason = await recovery
  const elapsedMs = Date.now() - started
  const hostText: unknown = await host.webContents.executeJavaScript('document.body.textContent')
  const sessionPoolProof = await probePluginViewerSessionPool(
    host,
    config.viewerPreloadPath,
    config.documentPath
  )
  await writeFile(
    config.resultPath,
    JSON.stringify({
      hosts,
      resolvedProxy,
      hostPid,
      guestPid,
      hostReplies,
      hostText,
      reason,
      elapsedMs,
      workerProof,
      workerTerminated,
      workerError,
      runtimeProof,
      runtimeReads,
      forgedRead,
      sessionPoolProof
    })
  )
  guest.webContents.close({ waitForBeforeUnload: false })
  host.destroy()
  guestSession.protocol.unhandle('orca-viewer-probe')
  for (const socket of sockets) {
    socket.destroy()
  }
  await new Promise<void>((resolve, reject) =>
    closedProxy.close((error) => (error ? reject(error) : resolve()))
  )
  clearTimeout(timeout)
  app.exit(0)
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
