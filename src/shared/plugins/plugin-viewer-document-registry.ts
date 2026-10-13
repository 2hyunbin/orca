import { randomUUID } from 'node:crypto'
import {
  pluginViewerDocumentOwnerSchema,
  type PluginViewerDocumentOwner
} from './plugin-viewer-document-owner'
export {
  pluginViewerDocumentOwnerSchema,
  type PluginViewerDocumentOwner
} from './plugin-viewer-document-owner'
import { waitForPromiseWithSignal } from '../abort-signal-reason'
import {
  PLUGIN_VIEWER_GLOBAL_READ_LIMIT,
  PLUGIN_VIEWER_OPENING_LIMIT,
  PLUGIN_VIEWER_SESSION_LIMIT,
  PLUGIN_VIEWER_SESSION_READ_LIMIT,
  PLUGIN_VIEWER_TRANSFER_BYTES,
  PluginViewerDocumentError,
  pluginViewerDocumentInfoSchema,
  pluginViewerReadRequestSchema,
  type PluginViewerDocumentInfo,
  type PluginViewerReadResponse
} from './plugin-viewer-document'
import {
  openPluginViewerFileResource,
  type PluginViewerFileRequest,
  type PluginViewerFileResource
} from './plugin-viewer-file-resource'

type DocumentSession = {
  owner: PluginViewerDocumentOwner
  controller: AbortController
  resource?: PluginViewerFileResource
  info?: PluginViewerDocumentInfo
  reads: number
  transferred: number
}

type RegistryOptions = {
  isAuthorized(owner: PluginViewerDocumentOwner): boolean | Promise<boolean>
  onCloseError(): void
  openFile?: (
    file: PluginViewerFileRequest,
    signal: AbortSignal,
    owner: PluginViewerDocumentOwner
  ) => Promise<PluginViewerFileResource>
}

function sameOwner(left: PluginViewerDocumentOwner, right: PluginViewerDocumentOwner): boolean {
  return (
    left.executionHostId === right.executionHostId &&
    left.workspaceId === right.workspaceId &&
    left.clientId === right.clientId &&
    left.tabId === right.tabId &&
    left.pluginKey === right.pluginKey &&
    left.pluginGeneration === right.pluginGeneration
  )
}

/** Instantiate on the execution host; callers derive owners from trusted transport state. */
export class PluginViewerDocumentRegistry {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly closing = new Set<Promise<void>>()
  private readonly openingSettlements = new Set<Promise<void>>()
  private opening = 0
  private reads = 0
  private disposed = false

  constructor(private readonly options: RegistryOptions) {}

  async create(
    trustedOwner: PluginViewerDocumentOwner,
    authorizedFile: PluginViewerFileRequest
  ): Promise<PluginViewerDocumentInfo> {
    const parsed = pluginViewerDocumentOwnerSchema.safeParse(trustedOwner)
    if (!parsed.success) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    if (this.disposed) {
      throw new PluginViewerDocumentError('unavailable')
    }
    if (
      this.sessions.size >= PLUGIN_VIEWER_SESSION_LIMIT ||
      this.opening >= PLUGIN_VIEWER_OPENING_LIMIT
    ) {
      throw new PluginViewerDocumentError('limit_exceeded')
    }
    const documentHandle = randomUUID()
    const session: DocumentSession = {
      owner: Object.freeze(parsed.data),
      controller: new AbortController(),
      reads: 0,
      transferred: 0
    }
    const file = { ...authorizedFile }
    this.sessions.set(documentHandle, session)
    this.opening++
    let finishOpening = (): void => {}
    const openingSettlement = new Promise<void>((resolve) => {
      finishOpening = resolve
    })
    this.openingSettlements.add(openingSettlement)
    try {
      await this.checkAuthority(documentHandle, session)
      session.resource = this.options.openFile
        ? await this.options.openFile(file, session.controller.signal, session.owner)
        : await openPluginViewerFileResource(file, session.controller.signal)
      await this.checkAuthority(documentHandle, session)
      session.info = pluginViewerDocumentInfoSchema.parse({
        documentHandle,
        name: session.resource.name,
        size: session.resource.size,
        revision: randomUUID(),
        features: { rangeRead: true, watch: false }
      })
      return structuredClone(session.info)
    } catch (error) {
      const code = session.controller.signal.aborted
        ? 'cancelled'
        : error instanceof PluginViewerDocumentError
          ? error.code
          : 'read_failed'
      this.retire(documentHandle, session)
      throw new PluginViewerDocumentError(code)
    } finally {
      this.opening--
      this.openingSettlements.delete(openingSettlement)
      finishOpening()
    }
  }

  async read(
    trustedOwner: PluginViewerDocumentOwner,
    input: unknown
  ): Promise<PluginViewerReadResponse> {
    const parsed = pluginViewerReadRequestSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: 'invalid_request' }
    }
    const request = parsed.data
    const session = this.sessions.get(request.documentHandle)
    if (!session || !sameOwner(session.owner, trustedOwner)) {
      return { ok: false, error: 'unauthorized' }
    }
    if (!session.info || !session.resource) {
      return { ok: false, error: 'unavailable' }
    }
    if (request.revision !== session.info.revision) {
      return { ok: false, error: 'stale_revision' }
    }
    if (
      session.reads >= PLUGIN_VIEWER_SESSION_READ_LIMIT ||
      this.reads >= PLUGIN_VIEWER_GLOBAL_READ_LIMIT
    ) {
      return { ok: false, error: 'limit_exceeded' }
    }
    const length = Math.max(0, Math.min(request.length, session.info.size - request.position))
    if (session.transferred + length > PLUGIN_VIEWER_TRANSFER_BYTES) {
      return { ok: false, error: 'limit_exceeded' }
    }
    session.transferred += length
    session.reads++
    this.reads++
    try {
      await this.checkAuthority(request.documentHandle, session)
      const bytes = await session.resource.read(
        request.position,
        request.length,
        session.controller.signal
      )
      await this.checkAuthority(request.documentHandle, session)
      if (bytes.length !== length) {
        throw new PluginViewerDocumentError('stale_revision')
      }
      return {
        ok: true,
        result: {
          revision: session.info.revision,
          bytesRead: bytes.length,
          contentBase64: bytes.toString('base64'),
          eof: request.position + bytes.length >= session.info.size
        }
      }
    } catch (error) {
      const code = session.controller.signal.aborted
        ? 'cancelled'
        : error instanceof PluginViewerDocumentError
          ? error.code
          : 'read_failed'
      if (code === 'stale_revision' || code === 'unauthorized') {
        this.retire(request.documentHandle, session)
      }
      return { ok: false, error: code }
    } finally {
      session.reads--
      this.reads--
    }
  }

  close(trustedOwner: PluginViewerDocumentOwner, documentHandle: string): void {
    const session = this.sessions.get(documentHandle)
    if (session && sameOwner(session.owner, trustedOwner)) {
      this.retire(documentHandle, session)
    }
  }

  revoke(matches: (owner: PluginViewerDocumentOwner) => boolean): void {
    for (const [id, session] of this.sessions) {
      if (matches(session.owner)) {
        this.retire(id, session)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.revoke(() => true)
    await Promise.all(this.openingSettlements)
    await Promise.all(this.closing)
  }

  private async checkAuthority(id: string, session: DocumentSession): Promise<void> {
    if (this.sessions.get(id) !== session) {
      throw new PluginViewerDocumentError('cancelled')
    }
    const allowed = await waitForPromiseWithSignal(
      Promise.resolve(this.options.isAuthorized(session.owner)),
      session.controller.signal
    )
    if (this.sessions.get(id) !== session) {
      throw new PluginViewerDocumentError('cancelled')
    }
    if (!allowed) {
      throw new PluginViewerDocumentError('unauthorized')
    }
  }

  private retire(id: string, session: DocumentSession): void {
    if (this.sessions.get(id) === session) {
      this.sessions.delete(id)
    }
    session.controller.abort()
    if (!session.resource) {
      return
    }
    const resource = session.resource
    session.resource = undefined
    const closing = Promise.resolve()
      .then(() => resource.close())
      .catch(() => this.options.onCloseError())
    this.closing.add(closing)
    void closing.then(
      () => this.closing.delete(closing),
      () => this.closing.delete(closing)
    )
  }
}
