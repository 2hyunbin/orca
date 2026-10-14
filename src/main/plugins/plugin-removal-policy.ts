import type { PluginService } from './plugin-service'
import type { PluginLockfile } from '../../shared/plugins/plugin-install-lockfile'

export function canRemoveInstalledPlugin(
  service: Pick<PluginService, 'getDiscovered' | 'isBundledDataPlugin'>,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    service
      .getDiscovered()
      .some(
        (plugin) =>
          plugin.pluginKey === pluginKey && !plugin.isDev && !service.isBundledDataPlugin(plugin)
      )
  )
}
