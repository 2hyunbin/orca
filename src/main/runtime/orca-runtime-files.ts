import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import type { RuntimeFileCommandHost } from './runtime-file-command-host'
import {
  RuntimePluginViewerDocuments,
  type RuntimeViewerTransport
} from './runtime-plugin-viewer-documents'

export class RuntimeFileCommands extends RuntimeFileCommandsWithCreateFileExplorerDirNoClobber {
  private readonly viewerDocuments: RuntimePluginViewerDocuments

  constructor(host: RuntimeFileCommandHost) {
    super(host)
    this.viewerDocuments = new RuntimePluginViewerDocuments(host)
  }

  openRuntimePluginViewerDocument(input: unknown, transport: RuntimeViewerTransport) {
    return this.viewerDocuments.open(input, transport)
  }

  selectRuntimePluginViewerFile(input: unknown, transport: RuntimeViewerTransport) {
    return this.viewerDocuments.select(input, transport)
  }

  readRuntimePluginViewerDocument(input: unknown, transport: RuntimeViewerTransport) {
    return this.viewerDocuments.read(input, transport)
  }

  closeRuntimePluginViewerDocument(input: unknown, transport: RuntimeViewerTransport) {
    return this.viewerDocuments.close(input, transport)
  }

  observeRuntimePluginViewerDocument(
    input: unknown,
    transport: RuntimeViewerTransport,
    emit: (result: unknown) => void
  ) {
    return this.viewerDocuments.observe(input, transport, emit)
  }
}
export { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from './runtime-file-commands-mobile-file-list-limit'
export { WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS } from './runtime-file-commands-mobile-file-list-limit'
export { awaitRuntimeFileWatcherUnsubscribes } from './runtime-file-watcher-leases'
export { _getRuntimeFileWatcherReleaseCountForTests } from './runtime-file-watcher-leases'
export { _resetRuntimeFileWatcherLeasesForTests } from './runtime-file-watcher-leases'
export type { ResolvedRuntimeFileWorktree } from './runtime-file-command-target'
export type { ResolvedRuntimeFileTarget } from './runtime-file-command-target'
export type { RuntimeFileCommandHost } from './runtime-file-command-host'
export { isSafeMobileRelativePath } from './runtime-file-command-host'
