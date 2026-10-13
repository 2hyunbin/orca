import { createHash, randomUUID } from 'node:crypto'
import {
  PLUGIN_VIEWER_SESSION_LIMIT,
  PLUGIN_VIEWER_OPENING_LIMIT,
  PluginViewerDocumentError,
  type PluginViewerDocumentErrorCode,
  type PluginViewerReadResponse
} from '../../shared/plugins/plugin-viewer-document'
import { PluginViewerDocumentRegistry } from '../../shared/plugins/plugin-viewer-document-registry'
import {
  pluginViewerRuntimeLeaseSchema,
  pluginViewerRuntimeOpenSchema,
  pluginViewerRuntimeReadSchema,
  type PluginViewerRuntimeLease
} from '../../shared/plugins/plugin-viewer-runtime-document'
import type { PluginViewerRemoteOpenResponse } from '../../shared/plugins/plugin-viewer-remote-document'
import {
  resolveRuntimePluginViewerFileRoute,
  type RuntimeViewerFileHost,
  type RuntimeViewerFileRoute
} from './runtime-plugin-viewer-file-route'
import { RuntimePluginViewerLeaseObserver } from './runtime-plugin-viewer-lease-observer'
import { RuntimePluginViewerSelections } from './runtime-plugin-viewer-selections'
import {
  runtimeViewerFailure as failure,
  runtimeViewerTransportIdentity as identity,
  type RuntimeViewerTransport
} from './runtime-plugin-viewer-transport'

export type { RuntimeViewerTransport } from './runtime-plugin-viewer-transport'

type Lease = {
  key: string
  identity: string
  ownerKey: string
  observer: RuntimePluginViewerLeaseObserver
  route?: RuntimeViewerFileRoute
  releaseCleanup?: () => void
  unsubscribe?: () => void
}

type Failure = { ok: false; error: PluginViewerDocumentErrorCode }

export class RuntimePluginViewerDocuments {
  private readonly leases = new Map<string, Lease>()
  private readonly owners = new Map<string, Lease>()
  private opening = 0
  private disposed = false
  private readonly selections: RuntimePluginViewerSelections
  private readonly registry = new PluginViewerDocumentRegistry({
    isAuthorized: (owner) => {
      const lease = this.owners.get(owner.clientId)
      return lease?.route?.isCurrent() ?? false
    },
    openFile: async (file, signal, owner) => {
      const route = this.owners.get(owner.clientId)?.route
      if (
        !route ||
        file.boundaryPath !== route.file.boundaryPath ||
        file.entryPath !== route.file.entryPath
      ) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      return route.openFile(signal)
    },
    onCloseError: () => console.error('[runtime] viewer document close failed')
  })

  constructor(private readonly host: RuntimeViewerFileHost) {
    this.selections = new RuntimePluginViewerSelections(
      host,
      () =>
        this.leases.size + this.selections.size < PLUGIN_VIEWER_SESSION_LIMIT &&
        this.opening + this.selections.pending < PLUGIN_VIEWER_OPENING_LIMIT
    )
  }

  select(input: unknown, transport: RuntimeViewerTransport) {
    if (this.disposed) {
      return Promise.resolve({ ok: false as const, error: 'unavailable' as const })
    }
    return this.selections.select(input, transport)
  }

  private key(transport: RuntimeViewerTransport, input: PluginViewerRuntimeLease): string {
    return `${createHash('sha256').update(transport.connectionId).digest('hex')}:${input.leaseId}`
  }

  private live(lease: Lease): boolean {
    return this.leases.get(lease.key) === lease
  }

  private retire(lease: Lease): void {
    if (!this.live(lease)) {
      return
    }
    this.leases.delete(lease.key)
    this.owners.delete(lease.ownerKey)
    lease.observer.close()
    lease.unsubscribe?.()
    this.registry.revoke((owner) => owner.clientId === lease.ownerKey)
    lease.route?.release?.()
    const release = lease.releaseCleanup
    lease.releaseCleanup = undefined
    release?.()
  }

  private lookup(
    transport: RuntimeViewerTransport,
    input: PluginViewerRuntimeLease
  ): Lease | undefined {
    if (!transport.connectionId || !transport.clientId) {
      return undefined
    }
    const lease = this.leases.get(this.key(transport, input))
    if (lease?.identity !== identity(transport, input)) {
      return undefined
    }
    if (this.host.getRuntimeId() !== input.runtimeId) {
      this.retire(lease)
      return undefined
    }
    return lease
  }

  async open(
    input: unknown,
    transport: RuntimeViewerTransport
  ): Promise<PluginViewerRemoteOpenResponse> {
    if (this.disposed) {
      return { ok: false, error: 'unavailable' }
    }
    const parsed = pluginViewerRuntimeOpenSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: 'invalid_request' }
    }
    const request = parsed.data
    if (
      !transport.connectionId ||
      !transport.clientId ||
      request.runtimeId !== this.host.getRuntimeId()
    ) {
      return { ok: false, error: 'unauthorized' }
    }
    const key = this.key(transport, request)
    if (request.selectionGrantId && !this.selections.matches(request, transport)) {
      return { ok: false, error: 'unauthorized' }
    }
    if (
      this.leases.has(key) ||
      this.leases.size + (request.selectionGrantId ? 0 : this.selections.size) >=
        PLUGIN_VIEWER_SESSION_LIMIT ||
      this.opening + this.selections.pending >= PLUGIN_VIEWER_OPENING_LIMIT
    ) {
      return { ok: false, error: 'limit_exceeded' }
    }
    const lease: Lease = {
      key,
      identity: identity(transport, request),
      ownerKey: randomUUID(),
      observer: new RuntimePluginViewerLeaseObserver()
    }
    this.leases.set(key, lease)
    this.owners.set(lease.ownerKey, lease)
    this.opening++
    const cancel = (): void => this.retire(lease)
    try {
      lease.releaseCleanup = transport.registerCleanup(cancel)
      transport.signal?.addEventListener('abort', cancel, { once: true })
      transport.signal?.throwIfAborted()
      lease.route = request.selectionGrantId
        ? this.selections.consume(request, transport, lease.ownerKey, () => this.live(lease))
        : await resolveRuntimePluginViewerFileRoute(this.host, request, lease.ownerKey, () =>
            this.live(lease)
          )
      lease.unsubscribe = lease.route.onInvalidated(cancel)
      if (!this.live(lease)) {
        lease.unsubscribe()
        throw new PluginViewerDocumentError('cancelled')
      }
      lease.route.document = await this.registry.create(lease.route.owner, lease.route.file)
      if (!this.live(lease) || transport.signal?.aborted) {
        throw new PluginViewerDocumentError('cancelled')
      }
      return {
        ok: true,
        document: { ...lease.route.document, features: { rangeRead: true, watch: false } }
      }
    } catch (error) {
      cancel()
      return transport.signal?.aborted ? { ok: false, error: 'cancelled' } : failure(error)
    } finally {
      this.opening--
      transport.signal?.removeEventListener('abort', cancel)
    }
  }

  async read(input: unknown, transport: RuntimeViewerTransport): Promise<PluginViewerReadResponse> {
    const parsed = pluginViewerRuntimeReadSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: 'invalid_request' }
    }
    const lease = this.lookup(transport, parsed.data)
    if (
      !lease?.route ||
      lease.route.document?.documentHandle !== parsed.data.request.documentHandle
    ) {
      return { ok: false, error: 'unauthorized' }
    }
    const cancel = (): void => this.retire(lease)
    transport.signal?.addEventListener('abort', cancel, { once: true })
    try {
      transport.signal?.throwIfAborted()
      const response = await this.registry.read(lease.route.owner, parsed.data.request)
      if (!this.live(lease) || transport.signal?.aborted) {
        return { ok: false, error: 'cancelled' }
      }
      if (
        !response.ok &&
        ['stale_revision', 'unauthorized', 'cancelled'].includes(response.error)
      ) {
        cancel()
      }
      return response
    } catch (error) {
      cancel()
      return transport.signal?.aborted ? { ok: false, error: 'cancelled' } : failure(error)
    } finally {
      transport.signal?.removeEventListener('abort', cancel)
    }
  }

  close(input: unknown, transport: RuntimeViewerTransport): { ok: true } | Failure {
    const parsed = pluginViewerRuntimeLeaseSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: 'invalid_request' }
    }
    const lease = this.lookup(transport, parsed.data)
    if (lease) {
      this.retire(lease)
    }
    return { ok: true }
  }

  async observe(
    input: unknown,
    transport: RuntimeViewerTransport,
    emit: (result: unknown) => void
  ): Promise<void> {
    const parsed = pluginViewerRuntimeLeaseSchema.safeParse(input)
    const lease = parsed.success ? this.lookup(transport, parsed.data) : undefined
    if (!parsed.success || !lease?.route?.document || !transport.signal) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    if (!(await lease.route.isCurrent())) {
      this.retire(lease)
    }
    try {
      await lease.observer.observe(
        (closed) =>
          emit({
            kind: 'plugin-viewer-lifecycle',
            leaseId: parsed.data.leaseId,
            runtimeId: parsed.data.runtimeId,
            closed
          }),
        transport.signal
      )
    } finally {
      if (transport.signal.aborted) {
        this.retire(lease)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const lease of this.leases.values()) {
      this.retire(lease)
    }
    await this.registry.dispose()
    await this.selections.dispose()
  }
}
