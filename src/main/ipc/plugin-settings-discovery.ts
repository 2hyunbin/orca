import type { Store } from '../persistence'
import type { PluginService } from '../plugins/plugin-service'

export function bindPluginSettingsDiscovery(
  store: Pick<Store, 'onSettingsChanged'>,
  service: Pick<PluginService, 'refresh'>
): void {
  store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      void service.refresh().catch((error) => {
        console.warn('[plugins] failed to apply plugin settings change:', error)
      })
    }
  })
}
