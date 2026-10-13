import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PairedRuntimeConnection } from '../paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../remote-runtime-request-connection'
import type { RuntimeRpcResponse } from '../runtime-rpc-envelope'
import type { PluginViewerDocumentOwner } from './plugin-viewer-document-owner'
import type { PluginViewerFileResource } from './plugin-viewer-file-resource'
import {
  PluginViewerDocumentError,
  pluginViewerReadRequestSchema,
  pluginViewerReadResponseSchema
} from './plugin-viewer-document'
import { pluginViewerRemoteOpenResponseSchema } from './plugin-viewer-remote-document'
import {
  PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY,
  PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY,
  pluginViewerRuntimeObservationSchema,
  pluginViewerRuntimeOpenSchema,
  pluginViewerRuntimeSelectionResponseSchema
} from './plugin-viewer-runtime-document'

const statusSchema = z.object({
  runtimeId: z.string().min(1).max(256),
  capabilities: z.array(z.string()).optional()
})

/** A document never moves to a replacement socket. */
export class PluginViewerRuntimeClient {
  private readonly connection: RemoteRuntimeRequestConnection
  private readonly controller = new AbortController()
  private started = false
  private closed = false
  private leaseId?: string
  private observationRequestId?: string

  constructor(
    pairing: PairedRuntimeConnection,
    private readonly runtimeId: string,
    private readonly onInvalidated: () => void
  ) {
    this.connection = new RemoteRuntimeRequestConnection(
      pairing,
      [PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY, PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY],
      {
        kind: 'single-connection',
        onClosed: () => this.close(),
        onResponse: (response) => this.receiveObservation(response)
      }
    )
  }

  async open(
    owner: PluginViewerDocumentOwner,
    filePath: string,
    signal: AbortSignal,
    options?: { userSelectedFile: boolean }
  ): Promise<PluginViewerFileResource> {
    if (this.closed || this.started) {
      throw new PluginViewerDocumentError('unavailable')
    }
    const parsed = pluginViewerRuntimeOpenSchema.safeParse({
      owner,
      filePath,
      runtimeId: this.runtimeId,
      leaseId: randomUUID()
    })
    if (!parsed.success) {
      throw new PluginViewerDocumentError('invalid_request')
    }
    this.started = true
    const input = parsed.data
    this.leaseId = input.leaseId
    const lifetime = AbortSignal.any([signal, this.controller.signal])
    const cancel = (): void => this.close()
    lifetime.addEventListener('abort', cancel, { once: true })
    try {
      const status = statusSchema.safeParse(
        this.result(await this.connection.request('status.get', undefined, 15_000, lifetime))
      )
      if (!status.success || status.data.runtimeId !== this.runtimeId) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      if (!status.data.capabilities?.includes(PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY)) {
        throw new PluginViewerDocumentError('unsupported_host')
      }
      let opening = input
      if (options?.userSelectedFile) {
        if (!status.data.capabilities?.includes(PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY)) {
          throw new PluginViewerDocumentError('unsupported_host')
        }
        const selection = pluginViewerRuntimeSelectionResponseSchema.safeParse(
          this.result(
            await this.connection.request('files.pluginViewer.select', input, 15_000, lifetime)
          )
        )
        if (!selection.success) {
          throw new PluginViewerDocumentError('read_failed')
        }
        if (!selection.data.ok) {
          throw new PluginViewerDocumentError(selection.data.error)
        }
        opening = { ...input, selectionGrantId: selection.data.grantId }
      }
      const response = pluginViewerRemoteOpenResponseSchema.safeParse(
        this.result(
          await this.connection.request('files.pluginViewer.open', opening, 15_000, lifetime)
        )
      )
      lifetime.throwIfAborted()
      if (!response.success) {
        throw new PluginViewerDocumentError('read_failed')
      }
      if (!response.data.ok) {
        throw new PluginViewerDocumentError(response.data.error)
      }
      const document = response.data.document
      const lease = { owner: input.owner, runtimeId: input.runtimeId, leaseId: input.leaseId }
      const observation = pluginViewerRuntimeObservationSchema.safeParse(
        this.result(
          await this.connection.request('files.pluginViewer.observe', lease, 15_000, lifetime)
        )
      )
      if (
        !observation.success ||
        observation.data.closed ||
        observation.data.leaseId !== input.leaseId ||
        observation.data.runtimeId !== this.runtimeId
      ) {
        throw new PluginViewerDocumentError('unauthorized')
      }
      lifetime.throwIfAborted()
      return {
        name: document.name,
        size: document.size,
        read: async (position, length, readSignal) => {
          if (this.closed) {
            throw new PluginViewerDocumentError('cancelled')
          }
          const read = pluginViewerReadRequestSchema.safeParse({
            documentHandle: document.documentHandle,
            revision: document.revision,
            position,
            length
          })
          if (!read.success) {
            throw new PluginViewerDocumentError('invalid_request')
          }
          const reading = AbortSignal.any([lifetime, readSignal])
          try {
            const reply = pluginViewerReadResponseSchema.safeParse(
              this.result(
                await this.connection.request(
                  'files.pluginViewer.read',
                  { ...lease, request: read.data },
                  15_000,
                  reading
                )
              )
            )
            reading.throwIfAborted()
            if (!reply.success) {
              throw new PluginViewerDocumentError('read_failed')
            }
            if (!reply.data.ok) {
              throw new PluginViewerDocumentError(reply.data.error)
            }
            const result = reply.data.result
            const expected = Math.max(0, Math.min(length, document.size - position))
            if (
              result.revision !== document.revision ||
              result.bytesRead !== expected ||
              result.eof !== position + expected >= document.size
            ) {
              throw new PluginViewerDocumentError('stale_revision')
            }
            return Buffer.from(result.contentBase64, 'base64')
          } catch (error) {
            const failure = this.failure(error, reading)
            this.close()
            throw failure
          }
        },
        close: async () => {
          lifetime.removeEventListener('abort', cancel)
          this.close()
        }
      }
    } catch (error) {
      const failure = this.failure(error, lifetime)
      lifetime.removeEventListener('abort', cancel)
      this.close()
      throw failure
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.controller.abort()
    this.connection.close()
    this.onInvalidated()
  }

  private receiveObservation(response: RuntimeRpcResponse<unknown>): void {
    const current = response.id === this.observationRequestId
    const event = pluginViewerRuntimeObservationSchema.safeParse(
      response.ok ? response.result : undefined
    )
    const owned =
      response._meta?.runtimeId === this.runtimeId &&
      event.success &&
      event.data.leaseId === this.leaseId &&
      event.data.runtimeId === this.runtimeId
    if (current && !owned) {
      this.close()
      return
    }
    if (owned) {
      this.observationRequestId ??= response.id
      if (event.data.closed) {
        this.close()
      }
    }
  }

  private result(response: RuntimeRpcResponse<unknown>): unknown {
    if (response._meta?.runtimeId !== this.runtimeId) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    if (!response.ok) {
      throw new PluginViewerDocumentError(
        response.error.code === 'method_not_found' ? 'unsupported_host' : 'unavailable'
      )
    }
    return response.result
  }

  private failure(error: unknown, signal: AbortSignal): PluginViewerDocumentError {
    return error instanceof PluginViewerDocumentError
      ? error
      : new PluginViewerDocumentError(signal.aborted ? 'cancelled' : 'unavailable')
  }
}
