import type { PluginViewerDocumentOwner } from '../../shared/plugins/plugin-viewer-document-registry'
import type {
  PluginViewerFileRequest,
  PluginViewerFileResource
} from '../../shared/plugins/plugin-viewer-file-resource'

export type PluginViewerFileAuthority = {
  isCurrent(): boolean
  openFile(
    file: PluginViewerFileRequest,
    signal: AbortSignal,
    owner: PluginViewerDocumentOwner
  ): Promise<PluginViewerFileResource>
  onInvalidated(listener: () => void): () => void
}

export function pluginViewerOwnerKey(owner: PluginViewerDocumentOwner): string {
  return JSON.stringify([
    owner.executionHostId,
    owner.workspaceId,
    owner.clientId,
    owner.tabId,
    owner.pluginKey,
    owner.pluginGeneration
  ])
}
