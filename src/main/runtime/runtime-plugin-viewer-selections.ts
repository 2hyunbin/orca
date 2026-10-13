import { randomUUID } from 'node:crypto'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerFileResource } from '../../shared/plugins/plugin-viewer-file-resource'
import {
  pluginViewerRuntimeSelectionSchema,
  type PluginViewerRuntimeOpen,
  type PluginViewerRuntimeSelection,
  type PluginViewerRuntimeSelectionResponse
} from '../../shared/plugins/plugin-viewer-runtime-document'
import {
  resolveRuntimePluginViewerFileRoute,
  type RuntimeViewerFileHost,
  type RuntimeViewerFileRoute
} from './runtime-plugin-viewer-file-route'
import {
  runtimeViewerFailure,
  runtimeViewerTransportIdentity,
  type RuntimeViewerTransport
} from './runtime-plugin-viewer-transport'

export const RUNTIME_VIEWER_SELECTION_TTL_MS = 30_000

type Selection = {
  id: string
  identity: string
  request: PluginViewerRuntimeSelection
  expiresAt: number
  controller: AbortController
  closed: boolean
  route?: RuntimeViewerFileRoute
  resource?: PluginViewerFileResource
  closePromise?: Promise<void>
  unsubscribe?: () => void
  releaseCleanup?: () => void
  timer?: ReturnType<typeof setTimeout>
}

/** Only the host-admin selection method may mint these exact-file grants. */
export class RuntimePluginViewerSelections {
  private readonly selections = new Map<string, Selection>()
  private readonly transferred = new Set<Selection>()
  private readonly closing = new Set<Promise<void>>()
  private readonly settlements = new Set<Promise<void>>()
  private disposed = false
  private opening = 0

  constructor(
    private readonly host: RuntimeViewerFileHost,
    private readonly canAdmit: () => boolean
  ) {}

  get size(): number {
    return this.selections.size
  }

  get pending(): number {
    return this.opening
  }

  private closeResource(selection: Selection): void {
    const resource = selection.resource
    if (!resource || selection.closePromise) {
      return
    }
    const closing = Promise.resolve()
      .then(() => resource.close())
      .catch(() => {
        console.error('[runtime] selected viewer file close failed')
      })
    selection.closePromise = closing
    this.closing.add(closing)
    void closing.finally(() => this.closing.delete(closing))
  }

  private retire(selection: Selection): void {
    if (!selection.closed) {
      selection.closed = true
      this.selections.delete(selection.id)
      this.transferred.delete(selection)
      selection.controller.abort()
    }
    clearTimeout(selection.timer)
    const unsubscribe = selection.unsubscribe
    const releaseCleanup = selection.releaseCleanup
    selection.unsubscribe = undefined
    selection.releaseCleanup = undefined
    unsubscribe?.()
    releaseCleanup?.()
    this.closeResource(selection)
  }

  async select(
    input: unknown,
    transport: RuntimeViewerTransport
  ): Promise<PluginViewerRuntimeSelectionResponse> {
    const parsed = pluginViewerRuntimeSelectionSchema.safeParse(input)
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
    if (this.disposed || !this.canAdmit()) {
      return { ok: false, error: this.disposed ? 'unavailable' : 'limit_exceeded' }
    }
    const selection: Selection = {
      id: randomUUID(),
      identity: runtimeViewerTransportIdentity(transport, request),
      request,
      expiresAt: Date.now() + RUNTIME_VIEWER_SELECTION_TTL_MS,
      controller: new AbortController(),
      closed: false
    }
    this.selections.set(selection.id, selection)
    this.opening++
    let settle = (): void => {}
    const settlement = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.settlements.add(settlement)
    const cancel = (): void => this.retire(selection)
    try {
      selection.releaseCleanup = transport.registerCleanup(() => {
        // Consuming transfers cleanup to the document lease before releasing this registration.
        if (this.selections.get(selection.id) === selection) {
          cancel()
        }
      })
      selection.timer = setTimeout(cancel, RUNTIME_VIEWER_SELECTION_TTL_MS)
      selection.timer.unref?.()
      transport.signal?.addEventListener('abort', cancel, { once: true })
      transport.signal?.throwIfAborted()
      selection.route = await resolveRuntimePluginViewerFileRoute(
        this.host,
        request,
        selection.id,
        () => !selection.closed && !this.disposed,
        { kind: 'host-selected-file' }
      )
      selection.unsubscribe = selection.route.onInvalidated(cancel)
      selection.controller.signal.throwIfAborted()
      selection.resource = await selection.route.openFile(selection.controller.signal)
      selection.controller.signal.throwIfAborted()
      if (!(await selection.route.isCurrent())) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      selection.controller.signal.throwIfAborted()
      return { ok: true, grantId: selection.id }
    } catch (error) {
      const cancelled = selection.controller.signal.aborted || transport.signal?.aborted
      cancel()
      return cancelled ? { ok: false, error: 'cancelled' } : runtimeViewerFailure(error)
    } finally {
      this.opening--
      transport.signal?.removeEventListener('abort', cancel)
      this.settlements.delete(settlement)
      settle()
    }
  }

  private lookup(
    input: PluginViewerRuntimeOpen,
    transport: RuntimeViewerTransport
  ): Selection | undefined {
    const selection = input.selectionGrantId
      ? this.selections.get(input.selectionGrantId)
      : undefined
    if (selection && selection.expiresAt <= Date.now()) {
      this.retire(selection)
      return undefined
    }
    return selection &&
      !selection.closed &&
      selection.route &&
      selection.resource &&
      selection.identity === runtimeViewerTransportIdentity(transport, input) &&
      selection.request.filePath === input.filePath
      ? selection
      : undefined
  }

  matches(input: PluginViewerRuntimeOpen, transport: RuntimeViewerTransport): boolean {
    return Boolean(this.lookup(input, transport))
  }

  consume(
    input: PluginViewerRuntimeOpen,
    transport: RuntimeViewerTransport,
    clientId: string,
    isLive: () => boolean
  ): RuntimeViewerFileRoute {
    const selection = this.lookup(input, transport)
    const route = selection?.route
    const resource = selection?.resource
    if (!selection || !route || !resource) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    this.selections.delete(selection.id)
    this.transferred.add(selection)
    clearTimeout(selection.timer)
    selection.unsubscribe?.()
    selection.releaseCleanup?.()
    selection.unsubscribe = undefined
    selection.releaseCleanup = undefined
    let opened = false
    const isCurrent = async (): Promise<boolean> =>
      isLive() && !selection.closed && (await route.isCurrent())
    return {
      ...route,
      owner: Object.freeze({ ...route.owner, clientId }),
      isCurrent,
      release: () => this.retire(selection),
      openFile: async (signal) => {
        try {
          if (opened || !(await isCurrent())) {
            throw new PluginViewerDocumentError('unauthorized')
          }
          opened = true
          // Recheck the selected handle's revision before transferring it to the document lease.
          await resource.read(0, 1, signal)
          if (!(await isCurrent())) {
            throw new PluginViewerDocumentError('unauthorized')
          }
          return {
            ...resource,
            close: async () => {
              this.retire(selection)
              await selection.closePromise
            }
          }
        } catch (error) {
          this.retire(selection)
          throw error
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const selection of this.selections.values()) {
      this.retire(selection)
    }
    for (const selection of this.transferred) {
      this.retire(selection)
    }
    await Promise.allSettled(this.settlements)
    await Promise.allSettled(this.closing)
  }
}
