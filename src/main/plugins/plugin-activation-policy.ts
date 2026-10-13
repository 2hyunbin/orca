import {
  getPluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginKillListEntry } from '../../shared/plugins/plugin-kill-list'
import type { PluginServiceOptions } from './plugin-service-options'

export function snapshotPluginConsentLists(source: {
  getPluginConsents: () => Record<string, string>
  getDisabledPlugins: () => string[]
}): PluginConsentLists {
  return {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins()
  }
}

export function isPluginApproved(
  enabled: boolean,
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): boolean {
  return (
    enabled &&
    getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, lists) === 'approved'
  )
}

export function pluginServiceActivationState(
  plugin: ValidDiscoveredPlugin,
  options: Pick<
    PluginServiceOptions,
    | 'getDisabledBundledDataPlugins'
    | 'isPluginSystemEnabled'
    | 'getPluginConsents'
    | 'getDisabledPlugins'
  >,
  ownsBundledData: (plugin: ValidDiscoveredPlugin) => boolean
): ReturnType<typeof getPluginActivationState> {
  if (
    options.getDisabledBundledDataPlugins?.().includes(plugin.pluginKey) &&
    plugin.manifest.manifestVersion === 2 &&
    plugin.manifest.execution === 'data'
  ) {
    return 'disabled'
  }
  if (ownsBundledData(plugin)) {
    return 'approved'
  }
  if (!options.isPluginSystemEnabled()) {
    return 'disabled'
  }
  return getPluginActivationState(
    plugin.pluginKey,
    plugin.consentFingerprint,
    snapshotPluginConsentLists(options)
  )
}

export function pluginServiceActivationError(
  blocked: PluginKillListEntry | null | undefined,
  contentError: () => string | null,
  workerError: () => string | null
): string | null {
  return (
    (blocked ? `Blocked by Orca's plugin safety list: ${blocked.reason}` : null) ??
    contentError() ??
    workerError()
  )
}
