import { PluginViewerResourceGuard } from './plugin-viewer-resource-guard'
import {
  capturePluginViewerProcessOwners,
  capturePluginViewerProcessMetrics
} from './plugin-viewer-process-ownership'

export function createPluginViewerNativeResourceGuard(): PluginViewerResourceGuard {
  return new PluginViewerResourceGuard({
    owners: capturePluginViewerProcessOwners,
    metrics: capturePluginViewerProcessMetrics,
    now: () => performance.now(),
    terminate: (pid) => {
      process.kill(pid, 'SIGKILL')
    }
  })
}
