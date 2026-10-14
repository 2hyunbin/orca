import type { PluginWorkerHostCallExecutor } from './plugin-host-process'
import type { PluginWorkerFactory } from './plugin-worker-startup'

export type PluginWorkerManagerOptions = {
  entryPath: string
  maxActive?: number
  idleReapMs?: number
  workerFactory?: PluginWorkerFactory
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown
  ) => ReturnType<PluginWorkerHostCallExecutor>
  log: (pluginKey: string) => (level: 'info' | 'warn' | 'error', line: string) => void
  onWorkerStateChange: (pluginKey: string) => void
  onWorkerGone: (pluginKey: string) => void
}
