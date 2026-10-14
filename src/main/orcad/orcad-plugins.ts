import { PluginMarketplaceService } from '../plugins/plugin-marketplace-service'
import { PluginMarketplaceInstaller } from '../plugins/plugin-marketplace-installer'
import { PluginManagementController } from '../plugins/plugin-management-controller'
import { PluginService } from '../plugins/plugin-service'
import { PluginKillListService } from '../plugins/plugin-kill-list-service'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/plugin-consent-state'
import type { Store } from '../persistence'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export async function startOrcadPlugins(options: {
  store: Pick<Store, 'getSettings' | 'updateSettings' | 'onSettingsChanged'>
  userDataPath: string
  hostVersion: string
  registerCleanup(cleanup: OrcadRuntimeCleanup): void
  marketplaceFetcher?: ConstructorParameters<typeof PluginMarketplaceService>[0]['fetcher']
  safetyList?: PluginKillListService
  launchEnvironment?: () => Promise<NodeJS.ProcessEnv>
}): Promise<PluginService> {
  const { store } = options
  const safetyList =
    options.safetyList ??
    new PluginKillListService({ pluginsDataDir: getPluginsDataDir(options.userDataPath) })
  await safetyList.initialize()
  let management: PluginManagementController | undefined
  const service = new PluginService({
    retirePluginManagement: () => management?.dispose() ?? Promise.resolve(),
    userDataPath: options.userDataPath,
    hostVersion: options.hostVersion,
    getEnvironmentRecipeLaunchEnvironment:
      options.launchEnvironment ?? resolveLoginShellEnvironment,
    isPluginSystemEnabled: () => store.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(store.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(store.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store.getSettings().devPluginPaths),
    getDisabledBundledDataPlugins: () => store.getSettings().disabledBundledDataPlugins ?? [],
    getPluginKillListEntry: (key) => safetyList.find(key)
  })
  const marketplace = new PluginMarketplaceService({
    fetcher: options.marketplaceFetcher,
    pluginsDataDir: getPluginsDataDir(options.userDataPath),
    getKillListEntry: (key) => safetyList.find(key)
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace,
    userDataPath: options.userDataPath,
    hostVersion: options.hostVersion,
    blockedPluginReason: (key) => safetyList.reason(key)
  })
  management = new PluginManagementController(service, store, { marketplace, installer })
  let stopping = false
  const report = (error: unknown): void => {
    if (!stopping) {
      console.warn('[orcad] plugin state refresh failed:', error)
    }
  }
  const reconcile = (): void => {
    void service.reconcileActivationState().catch(report)
  }
  const stopSafety = safetyList.onChanged(() => {
    if (!stopping) {
      reconcile()
    }
  })
  const stopSettings = store.onSettingsChanged((updates) => {
    if (stopping) {
      return
    }
    if ('devPluginPaths' in updates) {
      void service.refresh().catch(report)
    } else if (
      [
        'pluginSystemEnabled',
        'disabledPlugins',
        'pluginConsents',
        'disabledBundledDataPlugins'
      ].some((key) => Object.hasOwn(updates, key))
    ) {
      reconcile()
    }
    if (updates.pluginSystemEnabled === true) {
      void management?.seedOfficialSource().catch(report)
      void safetyList.refresh().catch(report)
    }
  })
  options.registerCleanup(async () => {
    stopping = true
    stopSettings()
    stopSafety()
    setPluginServiceForRpc(null)
    try {
      await service.dispose()
    } finally {
      await safetyList.dispose()
    }
  })
  await service.initialize()
  setPluginServiceForRpc(service, {
    management,
    applyConsent: (request) => applyPluginConsent({ store, pluginService: service, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService: service, pluginKey, enabled })
  })
  if (store.getSettings().pluginSystemEnabled === true) {
    void management?.seedOfficialSource().catch(report)
    void safetyList.refresh().catch(report)
  }
  return service
}
