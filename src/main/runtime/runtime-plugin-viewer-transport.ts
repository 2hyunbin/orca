import { createHash } from 'node:crypto'
import {
  PluginViewerDocumentError,
  type PluginViewerDocumentErrorCode
} from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerRuntimeLease } from '../../shared/plugins/plugin-viewer-runtime-document'

export type RuntimeViewerTransport = {
  connectionId: string
  clientId: string
  signal?: AbortSignal
  registerCleanup(cleanup: () => void): () => void
}

export function runtimeViewerFailure(error: unknown): {
  ok: false
  error: PluginViewerDocumentErrorCode
} {
  return {
    ok: false,
    error: error instanceof PluginViewerDocumentError ? error.code : 'read_failed'
  }
}

export function runtimeViewerTransportIdentity(
  transport: RuntimeViewerTransport,
  input: PluginViewerRuntimeLease
): string {
  // Serialized owner tags never select the actual socket or its credential.
  return createHash('sha256')
    .update(
      JSON.stringify([
        transport.connectionId,
        transport.clientId,
        input.runtimeId,
        input.leaseId,
        input.owner
      ])
    )
    .digest('hex')
}
