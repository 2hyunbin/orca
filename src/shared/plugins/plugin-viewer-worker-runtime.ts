import { isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'
import { PLUGIN_VIEWER_ENTRY_BYTES } from './plugin-viewer-contributions'
import { createPluginViewerWorkerBootstrap } from './plugin-viewer-worker-bootstrap'
import {
  PluginViewerWorkerHost,
  type PluginViewerWorkerHostOptions
} from './plugin-viewer-worker-host'

export function createPluginViewerWorkerRuntime(
  source: string,
  options: PluginViewerWorkerHostOptions
): { host: PluginViewerWorkerHost; dispose(): void } {
  if (!source.trim() || !isUtf8ByteLengthWithinLimit(source, PLUGIN_VIEWER_ENTRY_BYTES)) {
    throw new Error('invalid viewer worker source')
  }
  let authorUrl: string | null = null
  let bootstrapUrl: string | null = null
  let worker: Worker | null = null
  let host: PluginViewerWorkerHost | null = null
  const release = (): void => {
    if (authorUrl) {
      URL.revokeObjectURL(authorUrl)
    }
    if (bootstrapUrl) {
      URL.revokeObjectURL(bootstrapUrl)
    }
    authorUrl = null
    bootstrapUrl = null
  }
  try {
    authorUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const bootstrap = createPluginViewerWorkerBootstrap(authorUrl)
    bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
    worker = new Worker(bootstrapUrl)
    host = new PluginViewerWorkerHost(worker, {
      ...options,
      onError(code) {
        release()
        options.onError(code)
      }
    })
    const ownedHost = host
    return {
      host: ownedHost,
      dispose() {
        ownedHost.dispose()
        release()
      }
    }
  } catch (error) {
    host?.dispose()
    worker?.terminate()
    release()
    throw error
  }
}
