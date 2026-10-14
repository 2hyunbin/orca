import type { PluginService } from './plugin-service'
import type { Store } from '../persistence'
import { pluginManagementInstallSchema } from '../../shared/plugins/plugin-management-api'
import { getUserPluginsDir, getPluginsDataDir } from './plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import { canRemoveInstalledPlugin } from './plugin-removal-policy'
import { normalizePluginIdList } from '../../shared/plugins/plugin-consent-state'
import { listPluginsForClients } from './plugin-client-list'

export async function installPluginForHost(service: PluginService, raw: unknown) {
  await service.whenReady()
  const source = pluginManagementInstallSchema.parse(raw)
  const options = {
    pluginsDir: getUserPluginsDir(service.options.userDataPath),
    hostVersion: service.options.hostVersion,
    blockedPluginReason: (key: string) =>
      service.options.getPluginKillListEntry?.(key)?.reason ?? null
  }
  const result =
    source.kind === 'git'
      ? await installPluginFromGit({ ...options, url: source.url, ref: source.ref })
      : await installPluginFromLocalPath({ ...options, sourcePath: source.path })
  if (result.ok) {
    await service.refresh()
  }
  return result
}

export async function removePluginForHost(
  service: PluginService,
  store: Pick<Store, 'getSettings' | 'updateSettings'>,
  pluginKey: string,
  originWebContentsId?: number
) {
  await service.whenReady()
  const pluginsDir = getUserPluginsDir(service.options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  if (!canRemoveInstalledPlugin(service, pluginKey, lock)) {
    throw new Error(`cannot remove protected or non-installed plugin ${pluginKey}`)
  }
  await service.removePlugin(pluginKey, () =>
    removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(service.options.userDataPath),
      pluginKey
    })
  )
  const settings = store.getSettings()
  const consents = { ...settings.pluginConsents }
  delete consents[pluginKey]
  store.updateSettings(
    {
      pluginConsents: consents,
      disabledPlugins: normalizePluginIdList(settings.disabledPlugins).filter(
        (key) => key !== pluginKey
      )
    },
    { notifyListeners: true, originWebContentsId }
  )
  await service.refresh()
  return listPluginsForClients(service)
}
