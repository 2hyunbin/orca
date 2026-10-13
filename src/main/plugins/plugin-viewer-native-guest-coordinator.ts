import type { WebContents, Session } from 'electron'
import {
  PluginViewerDocumentError,
  type PluginViewerReadResponse
} from '../../shared/plugins/plugin-viewer-document'
import {
  PluginViewerDocumentRegistry,
  type PluginViewerDocumentOwner
} from '../../shared/plugins/plugin-viewer-document-registry'
import {
  openPluginViewerFileResource,
  type PluginViewerFileRequest
} from '../../shared/plugins/plugin-viewer-file-resource'
import {
  pluginViewerOwnerKey as ownerKey,
  type PluginViewerFileAuthority
} from './plugin-viewer-file-authority'
import { observePluginViewerApprovalLifetime } from './plugin-viewer-approval-lifetime'
import type { PluginViewerInitializeResponse } from '../../shared/plugins/plugin-viewer-initialize'
import type { PluginViewerRegistry } from './plugin-viewer-registry'
import type { PluginViewerSessionLease } from './plugin-viewer-session-pool'
import { PluginViewerHostLifetime } from './plugin-viewer-host-lifetime'
import {
  acquirePluginViewerSession,
  getActivePluginViewerLease,
  isBoundPluginViewerGuest,
  retirePluginViewerSession
} from './plugin-viewer-session-runtime'
import { isPluginViewerNativeGuestCurrent } from './plugin-viewer-native-guest-authorization'
import { startPluginViewerGuestLifetime } from './plugin-viewer-guest-lifetime'
import { createPluginViewerNativeResourceGuard } from './plugin-viewer-native-process-guard'
import { copyPluginViewerGuestSelection } from './plugin-viewer-native-selection'
import type { OpenedPluginViewer as OpenedViewer } from './plugin-viewer-native-guest-record'

type CoordinatorDependencies = {
  viewers: Pick<PluginViewerRegistry, 'list' | 'isCurrent' | 'loadSource'>
  whenReady(): Promise<void>
  onChanged(listener: () => void): () => void
}

/** Private native guests use the file owner's pinned local or negotiated remote transport. */
export class PluginViewerNativeGuestCoordinator {
  private readonly opened = new Map<string, OpenedViewer>()
  private readonly owners = new Map<string, OpenedViewer>()
  private readonly documents: PluginViewerDocumentRegistry
  private readonly unsubscribe: () => void
  private readonly resources = createPluginViewerNativeResourceGuard()
  private disposed = false

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.documents = new PluginViewerDocumentRegistry({
      isAuthorized: async (owner) => {
        await dependencies.whenReady()
        const state = this.owners.get(ownerKey(owner))
        return Boolean(state?.guest && this.isAuthorized(state, state.guest))
      },
      onCloseError() {
        console.warn('[plugins] viewer document close failed')
      },
      openFile: (file, signal, owner) => {
        const state = this.owners.get(ownerKey(owner))
        if (!state || (state.authority && !state.authority.isCurrent())) {
          throw new PluginViewerDocumentError('unauthorized')
        }
        return state.authority
          ? state.authority.openFile(file, signal, owner)
          : openPluginViewerFileResource(file, signal)
      }
    })
    this.unsubscribe = observePluginViewerApprovalLifetime({
      whenReady: () => dependencies.whenReady(),
      onChanged: (listener) => dependencies.onChanged(listener),
      isCurrent: (viewer) =>
        dependencies.viewers.isCurrent(viewer.key, viewer.revision, viewer.generation),
      leases: () => this.opened.values(),
      close: (id) => this.close(id)
    })
  }

  async create(input: {
    host: WebContents
    owner: Pick<PluginViewerDocumentOwner, 'executionHostId' | 'workspaceId' | 'tabId'>
    viewerKey: string
    file: PluginViewerFileRequest
    authority?: PluginViewerFileAuthority
    bootstrap: string
  }): Promise<PluginViewerSessionLease<Session>> {
    const host = input.host
    const context = { ...input.owner }
    const file = { ...input.file }
    const viewerKey = input.viewerKey
    const bootstrap = input.bootstrap
    const authority = input.authority
    if (context.executionHostId !== 'local' && !authority) {
      throw new PluginViewerDocumentError('unsupported_host')
    }
    let leaseId: string | null = null
    const lifetime = new PluginViewerHostLifetime(host, () => {
      if (leaseId) {
        void this.close(leaseId).catch(() => {})
      }
    })
    try {
      await this.dependencies.whenReady()
      if (!lifetime.isCurrent() || (authority && !authority.isCurrent())) {
        throw new PluginViewerDocumentError('cancelled')
      }
      const viewer = this.dependencies.viewers
        .list()
        .find((candidate) => candidate.key === viewerKey)
      if (this.disposed || host.isDestroyed() || !viewer) {
        throw new PluginViewerDocumentError('unavailable')
      }
      const owner = Object.freeze({
        ...context,
        clientId: `renderer:${host.id}`,
        pluginKey: viewer.pluginKey,
        pluginGeneration: viewer.generation
      })
      if (this.owners.has(ownerKey(owner))) {
        throw new PluginViewerDocumentError('limit_exceeded')
      }
      const lease = await acquirePluginViewerSession(
        {
          hostWebContentsId: host.id,
          tabId: owner.tabId,
          pluginKey: viewer.pluginKey,
          pluginGeneration: viewer.generation
        },
        bootstrap
      )
      leaseId = lease.id
      if (
        this.disposed ||
        !lifetime.isCurrent() ||
        this.owners.has(ownerKey(owner)) ||
        (authority && !authority.isCurrent())
      ) {
        await retirePluginViewerSession(lease.id)
        throw new PluginViewerDocumentError('cancelled')
      }
      const state: OpenedViewer = {
        lease,
        host,
        owner,
        viewer,
        file,
        authority,
        initializing: false,
        initialized: false,
        closed: false,
        cleanup: () => lifetime.dispose()
      }
      this.opened.set(lease.id, state)
      this.owners.set(ownerKey(owner), state)
      const stopAuthority = authority?.onInvalidated(() => {
        void this.close(lease.id).catch(() => {})
      })
      state.cleanup = () => {
        stopAuthority?.()
        lifetime.dispose()
      }
      if (state.closed) {
        stopAuthority?.()
      }
      if (state.closed || (authority && !authority.isCurrent())) {
        await this.close(lease.id)
        throw new PluginViewerDocumentError('cancelled')
      }
      return lease
    } catch (error) {
      if (leaseId) {
        await this.close(leaseId).catch(() => {})
      }
      lifetime.dispose()
      throw error
    }
  }

  async initialize(
    guest: WebContents,
    isMainFrame: boolean
  ): Promise<PluginViewerInitializeResponse> {
    const state = this.resolveGuest(guest, isMainFrame)
    if (!state) {
      return { ok: false, error: 'unauthorized' }
    }
    if (state.initializing || state.document) {
      return { ok: false, error: 'unavailable' }
    }
    state.initializing = true
    try {
      await this.dependencies.whenReady()
      if (!this.isAuthorized(state, guest)) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      state.guest = guest
      state.pid = guest.getOSProcessId()
      const cleanupGuest = startPluginViewerGuestLifetime({
        guest,
        host: state.host,
        leaseId: state.lease.id,
        resources: this.resources,
        close: () => this.close(state.lease.id)
      })
      const cleanupHost = state.cleanup
      state.cleanup = () => {
        cleanupHost()
        cleanupGuest()
      }
      state.document = await this.documents.create(state.owner, state.file)
      const source = await this.dependencies.viewers.loadSource(
        state.viewer.key,
        state.viewer.revision,
        state.viewer.generation
      )
      await this.dependencies.whenReady()
      if (!source || !this.isAuthorized(state, guest)) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      state.initialized = true
      return {
        ok: true,
        result: { viewer: structuredClone(state.viewer), document: state.document, source }
      }
    } catch (error) {
      const code = error instanceof PluginViewerDocumentError ? error.code : 'unavailable'
      await this.close(state.lease.id).catch(() => {})
      return { ok: false, error: code }
    }
  }

  async read(
    guest: WebContents,
    isMainFrame: boolean,
    request: unknown
  ): Promise<PluginViewerReadResponse> {
    const state = this.resolveGuest(guest, isMainFrame)
    if (!state || !state.initialized || !state.document) {
      return { ok: false, error: 'unauthorized' }
    }
    try {
      await this.dependencies.whenReady()
      if (!this.isAuthorized(state, guest)) {
        void this.close(state.lease.id).catch(() => {})
        return { ok: false, error: 'unauthorized' }
      }
      return await this.documents.read(state.owner, request)
    } catch {
      return { ok: false, error: 'unavailable' }
    }
  }

  copySelection(guest: WebContents, isMainFrame: boolean): boolean {
    const state = this.resolveGuest(guest, isMainFrame)
    return Boolean(
      state?.initialized &&
      state.guest === guest &&
      this.isAuthorized(state, guest) &&
      copyPluginViewerGuestSelection(guest, state)
    )
  }

  async closeForHost(id: string, hostWebContentsId: number): Promise<void> {
    if (this.opened.get(id)?.lease.owner.hostWebContentsId === hostWebContentsId) {
      await this.close(id)
    }
  }

  async close(id: string): Promise<void> {
    const state = this.opened.get(id)
    if (!state || state.closed) {
      return
    }
    state.closed = true
    this.opened.delete(id)
    this.owners.delete(ownerKey(state.owner))
    this.documents.revoke((owner) => ownerKey(owner) === ownerKey(state.owner))
    state.cleanup()
    await retirePluginViewerSession(id)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.resources.dispose()
    this.unsubscribe()
    await Promise.allSettled([...this.opened.keys()].map((id) => this.close(id)))
    await this.documents.dispose()
  }

  private resolveGuest(guest: WebContents, isMainFrame: boolean): OpenedViewer | undefined {
    if (!isMainFrame || guest.isDestroyed()) {
      return undefined
    }
    const lease = getActivePluginViewerLease(guest.session)
    const state = lease ? this.opened.get(lease.id) : undefined
    return state && isBoundPluginViewerGuest(state.lease, guest) ? state : undefined
  }

  private isAuthorized(state: OpenedViewer, guest: WebContents): boolean {
    return isPluginViewerNativeGuestCurrent(
      state,
      guest,
      this.resources,
      this.dependencies.viewers,
      this.disposed
    )
  }
}
