import { WebContentsView, type BrowserWindow } from 'electron'
import { dirname } from 'node:path'
import {
  disposePluginViewerSessions,
  getActivePluginViewerLease,
  isPluginViewerSession,
  reservePluginViewerAttach,
  retirePluginViewerSession
} from './plugin-viewer-session-runtime'
import { installPluginViewerGuestPolicy } from './plugin-viewer-guest-policy'
import { PluginViewerNativeGuestCoordinator } from './plugin-viewer-native-guest-coordinator'
import { registerPluginViewerGuestTransport } from '../ipc/plugin-viewer-guests'
import { pluginViewerMetadataSchema } from '../../shared/plugins/plugin-viewer-package'
import { pluginViewerDocumentInfoSchema } from '../../shared/plugins/plugin-viewer-document'

export async function probePluginViewerSessionPool(
  host: BrowserWindow,
  preload: string,
  documentPath: string
) {
  const owner = {
    hostWebContentsId: host.webContents.id,
    tabId: 'pool-probe-first',
    pluginKey: 'probe.viewer',
    pluginGeneration: 1
  }
  let approved = true
  let viewer = pluginViewerMetadataSchema.parse({
    id: 'fixture',
    displayName: 'Fixture',
    selector: [{ filenamePattern: '*.viewer' }],
    rendering: 'host-ui',
    mode: 'readonly',
    key: 'viewer:probe.viewer/fixture',
    pluginKey: 'probe.viewer',
    pluginName: 'Probe viewer',
    revision: 'first',
    generation: 1
  })
  const listeners = new Set<() => void>()
  const coordinator = new PluginViewerNativeGuestCoordinator({
    viewers: {
      list: () => (approved ? [structuredClone(viewer)] : []),
      isCurrent: (key, revision, generation) =>
        approved &&
        key === viewer.key &&
        revision === viewer.revision &&
        generation === viewer.generation,
      loadSource: async () => 'orcaViewer.register({open() {}, render() {}})'
    },
    whenReady: async () => {},
    onChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  })
  const disposeTransport = registerPluginViewerGuestTransport(() => coordinator)
  const create = (tabId: string, bootstrap: string) =>
    coordinator.create({
      host: host.webContents,
      viewerKey: viewer.key,
      bootstrap,
      owner: { executionHostId: 'local', workspaceId: 'folder-probe', tabId },
      file: { boundaryPath: dirname(documentPath), entryPath: documentPath }
    })
  const first = await create(owner.tabId, '<!doctype html><p>First private viewer</p>')
  const createGuest = (privateSession: Electron.Session): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: {
        session: privateSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        additionalArguments: ['--blink-settings=dnsPrefetchingEnabled=false'],
        preload,
        backgroundThrottling: false
      }
    })
    host.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 400, height: 80 })
    return view
  }
  try {
    const wrongHostDenied = !reservePluginViewerAttach(
      owner.hostWebContentsId + 1,
      first.partition,
      first.url
    )
    const admitted = reservePluginViewerAttach(owner.hostWebContentsId, first.partition, first.url)
    const duplicateDenied = !reservePluginViewerAttach(
      owner.hostWebContentsId,
      first.partition,
      first.url
    )
    const guest = createGuest(first.session)
    const firstContents = guest.webContents
    const disposePolicy = installPluginViewerGuestPolicy(guest.webContents, host.webContents, first)
    await guest.webContents.loadURL(first.url)
    const firstText: unknown = await guest.webContents.executeJavaScript(
      'document.body.textContent'
    )
    const preloadKeys: unknown = await guest.webContents.executeJavaScript(
      'Object.keys(orcaFileViewerHost).sort()'
    )
    const privilegedBridgeAbsent: unknown = await guest.webContents.executeJavaScript(
      'typeof window.electron === "undefined" && typeof window.api === "undefined"'
    )
    const beforeInitialization: unknown = await guest.webContents.executeJavaScript(
      'orcaFileViewerHost.read({})'
    )
    const initializationProof: unknown = await guest.webContents.executeJavaScript(`(async () => {
      const opened = await orcaFileViewerHost.initialize();
      if (!opened.ok) throw new Error(opened.error);
      globalThis.openedDocument = opened.result.document;
      const result = await orcaFileViewerHost.read({
        documentHandle: opened.result.document.documentHandle,
        revision: opened.result.document.revision, position: 0, length: 1
      });
      return {
        initialized: opened.ok,
        sourceAdmitted: opened.result.source.includes('orcaViewer.register'),
        metadataKeys: Object.keys(opened.result.document).sort(),
        byte: result.ok ? atob(result.result.contentBase64).charCodeAt(0) : -1
      };
    })()`)
    const document = pluginViewerDocumentInfoSchema.parse(
      await guest.webContents.executeJavaScript('globalThis.openedDocument')
    )
    const forgedProductionRead = await coordinator.read(host.webContents, true, {
      documentHandle: document.documentHandle,
      revision: document.revision,
      position: 0,
      length: 1
    })
    const subframeDenied = await coordinator.read(guest.webContents, false, {
      documentHandle: document.documentHandle,
      revision: document.revision,
      position: 0,
      length: 1
    })
    await guest.webContents.executeJavaScript('localStorage.setItem("private-viewer", "first")')
    await first.session.cookies.set({
      url: 'https://viewer-storage.invalid',
      name: 'private-viewer',
      value: 'first'
    })
    const seededCookie = (await first.session.cookies.get({ name: 'private-viewer' })).length === 1
    disposePolicy()
    await retirePluginViewerSession(first.id)
    const destroyedBeforeReuse = firstContents.isDestroyed()
    const privateAfterRetirement = isPluginViewerSession(first.session)
    viewer = { ...viewer, revision: 'second', generation: 2 }
    const second = await create('pool-probe-second', '<!doctype html><p>Second private viewer</p>')
    const sameSession = second.session === first.session
    const changedLease = second.id !== first.id && second.url !== first.url
    const clearedCookies = (await second.session.cookies.get({})).length === 0
    await retirePluginViewerSession(first.id)
    const staleRetirementIgnored = getActivePluginViewerLease(second.session) === second
    reservePluginViewerAttach(owner.hostWebContentsId, second.partition, second.url)
    const replacement = createGuest(second.session)
    const secondContents = replacement.webContents
    const disposeReplacement = installPluginViewerGuestPolicy(
      replacement.webContents,
      host.webContents,
      second
    )
    const oldUrlDenied = await replacement.webContents.loadURL(first.url).then(
      () => false,
      () => true
    )
    await replacement.webContents.loadURL(second.url)
    const secondText: unknown = await replacement.webContents.executeJavaScript(
      'document.body.textContent'
    )
    const nonpersistent = second.session.getStoragePath() === null
    const secondDocument = pluginViewerDocumentInfoSchema.parse(
      await secondContents.executeJavaScript(
        '(async () => { const opened = await orcaFileViewerHost.initialize(); if (!opened.ok) throw new Error(opened.error); return opened.result.document; })()'
      )
    )
    approved = false
    for (const listener of listeners) {
      listener()
    }
    const revokedRead = await coordinator.read(secondContents, true, {
      documentHandle: secondDocument.documentHandle,
      revision: secondDocument.revision,
      position: 0,
      length: 1
    })
    await retirePluginViewerSession(second.id)
    const destroyedOnRevocation = secondContents.isDestroyed()
    disposeReplacement()
    await retirePluginViewerSession(second.id)
    return {
      admitted,
      wrongHostDenied,
      duplicateDenied,
      firstText,
      secondText,
      preloadKeys,
      privilegedBridgeAbsent,
      seededCookie,
      destroyedBeforeReuse,
      privateAfterRetirement,
      sameSession,
      changedLease,
      clearedCookies,
      staleRetirementIgnored,
      oldUrlDenied,
      nonpersistent,
      beforeInitialization,
      initializationProof,
      forgedProductionRead,
      subframeDenied,
      revokedRead,
      destroyedOnRevocation
    }
  } finally {
    disposeTransport()
    await coordinator.dispose()
    await disposePluginViewerSessions()
  }
}
