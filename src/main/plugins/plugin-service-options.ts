import type { PluginWorkerFactory } from './plugin-worker-manager'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { PluginKillListEntry } from '../../shared/plugins/plugin-kill-list'

export type PluginServiceOptions = {
  retireEnvironmentProviderConnections?: (providerId: string, resourceId?: string) => Promise<void>
  getEnvironmentRecipeLaunchEnvironment?: () => Promise<NodeJS.ProcessEnv>
  userDataPath: string
  hostVersion: string
  bundledPluginsRoot?: string
  isPluginSystemEnabled: () => boolean
  getDisabledPlugins: () => string[]
  getDisabledBundledDataPlugins?: () => string[]
  getPluginConsents: () => Record<string, string>
  getDevPluginPaths: () => string[]
  getKeybindings?: () => KeybindingOverrides
  getPluginKillListEntry?: (pluginKey: string) => PluginKillListEntry | null
  hostEntryPath?: string
  workerFactory?: PluginWorkerFactory
  maxActiveWorkers?: number
  idleReapMs?: number
}
