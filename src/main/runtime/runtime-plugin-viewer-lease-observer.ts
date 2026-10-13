import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'

export class RuntimePluginViewerLeaseObserver {
  private closed = false
  private observed = false
  private finish?: () => void

  close(): void {
    this.closed = true
    this.finish?.()
    this.finish = undefined
  }

  async observe(emit: (closed: boolean) => void, signal: AbortSignal): Promise<void> {
    if (this.observed) {
      throw new PluginViewerDocumentError('limit_exceeded')
    }
    this.observed = true
    if (this.closed || signal.aborted) {
      emit(true)
      return
    }
    const completed = new Promise<void>((resolve) => {
      this.finish = resolve
    })
    const cancel = (): void => this.close()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      emit(false)
      await completed
      emit(true)
    } finally {
      signal.removeEventListener('abort', cancel)
      this.close()
    }
  }
}
