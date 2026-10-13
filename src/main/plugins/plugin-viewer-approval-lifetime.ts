import type { PluginViewerMetadata } from '../../shared/plugins/plugin-viewer-package'

export function observePluginViewerApprovalLifetime(input: {
  whenReady(): Promise<void>
  onChanged(listener: () => void): () => void
  isCurrent(viewer: PluginViewerMetadata): boolean
  leases(): Iterable<{ lease: { id: string }; viewer: PluginViewerMetadata }>
  close(id: string): Promise<void>
}): () => void {
  return input.onChanged(() => {
    void input
      .whenReady()
      .then(() => {
        for (const state of input.leases()) {
          if (!input.isCurrent(state.viewer)) {
            void input.close(state.lease.id).catch(() => {})
          }
        }
      })
      .catch(() => {})
  })
}
