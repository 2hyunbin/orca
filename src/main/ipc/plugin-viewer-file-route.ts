import { dirname } from 'node:path'
import type { Store } from '../persistence'
import { parseExecutionHostId } from '../../shared/execution-host'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerOpenRequest } from '../../shared/plugins/plugin-viewer-open'
import type { PluginViewerFileRequest } from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerFileAuthority } from '../plugins/plugin-viewer-file-authority'
import { resolveLocalFileRequestPath } from './local-file-access-resolution'
import { resolvePluginViewerRuntimeFileRoute } from './plugin-viewer-runtime-file-route'

export async function resolvePluginViewerFileRoute(
  store: Store,
  input: PluginViewerOpenRequest,
  runtimeUserDataPath?: string
): Promise<{ file: PluginViewerFileRequest; authority?: PluginViewerFileAuthority }> {
  const request = structuredClone(input)
  const host = parseExecutionHostId(request.executionHostId)
  if (!host || host.id !== request.executionHostId) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  if (host.kind === 'runtime') {
    if (!runtimeUserDataPath) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    return resolvePluginViewerRuntimeFileRoute(runtimeUserDataPath, request)
  }
  if (
    request.expectedEnvironmentPairingRevision !== undefined ||
    request.expectedEnvironmentRuntimeId !== undefined
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  // SSH machines are served by their paired Orca runtime; their paths never reach desktop fs.
  if (host.kind === 'ssh') {
    throw new PluginViewerDocumentError('unsupported_host')
  }
  if (request.expectedSshConnectionGeneration !== undefined) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const path = await resolveLocalFileRequestPath(request.filePath, request.access, store)
  return { file: { boundaryPath: dirname(path), entryPath: path } }
}
