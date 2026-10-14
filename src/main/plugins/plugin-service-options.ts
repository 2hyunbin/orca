import type { PluginWorkerFactory } from './plugin-worker-manager'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { PluginKillListEntry } from '../../shared/plugins/plugin-kill-list'
import type { SshTarget } from '../../shared/ssh-types'
import type { EnvironmentAdapterRuntime } from './plugin-environment-adapter-launch'

export type PluginServiceOptions = {
  retireEnvironmentProviderConnections?: (providerId: string, resourceId?: string) => Promise<void>
  retireEnvironmentProviderSshTarget?: (target: SshTarget) => Promise<void>
  getEnvironmentRecipeLaunchEnvironment?: () => Promise<NodeJS.ProcessEnv>
  environmentAdapterRuntime?: EnvironmentAdapterRuntime
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
