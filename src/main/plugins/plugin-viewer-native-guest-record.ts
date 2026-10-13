import type { WebContents, Session } from 'electron'
import type { PluginViewerDocumentInfo } from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerDocumentOwner } from '../../shared/plugins/plugin-viewer-document-registry'
import type { PluginViewerFileRequest } from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerMetadata } from '../../shared/plugins/plugin-viewer-package'
import type { PluginViewerFileAuthority } from './plugin-viewer-file-authority'
import type { PluginViewerSessionLease } from './plugin-viewer-session-pool'

export type OpenedPluginViewer = {
  lease: PluginViewerSessionLease<Session>
  host: WebContents
  owner: PluginViewerDocumentOwner
  viewer: PluginViewerMetadata
  file: PluginViewerFileRequest
  authority?: PluginViewerFileAuthority
  guest?: WebContents
  pid?: number
  document?: PluginViewerDocumentInfo
  initializing: boolean
  initialized: boolean
  lastCopyAt?: number
  closed: boolean
  cleanup(): void
}
