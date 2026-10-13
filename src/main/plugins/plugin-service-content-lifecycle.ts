import type { PluginConsentLists } from '../../shared/plugins/plugin-consent-state'
import { discoverPlugins, getUserPluginsDir, type ValidDiscoveredPlugin } from './plugin-discovery'
import { isPluginApproved, snapshotPluginConsentLists } from './plugin-activation-policy'
import { collectApprovedWorkerSpecs } from './plugin-worker-reconciliation'
import type { PluginServiceOptions } from './plugin-service-options'
import type { PluginContentPackRegistry } from './plugin-content-pack-registry'
import type { PluginContentVerifier } from './plugin-content-integrity'
import type { PluginBundledDataRegistry } from './plugin-bundled-data-registry'
import type { PluginInstallationState } from './plugin-installation-state'
import type { PluginWorkerController } from './plugin-worker-controller'
import type { PluginPanelController } from './plugin-panel-controller'
import type { PluginServiceHousekeeping } from './plugin-service-housekeeping'

export type PluginServiceContentLifecycleHost = {
  options: PluginServiceOptions
  contentPacks: PluginContentPackRegistry
  contentVerifier: PluginContentVerifier
  bundledData: PluginBundledDataRegistry
  installed: PluginInstallationState
  workerController: PluginWorkerController
  panels: PluginPanelController
  housekeeping: PluginServiceHousekeeping
  isDisposed(): boolean
  setReady(ready: boolean): void
  isRuntimeApproved(plugin: ValidDiscoveredPlugin): boolean
  activationState(plugin: ValidDiscoveredPlugin): string
  notifyChanged(contentPacksChanged: boolean): void
  scheduleRefresh(): void
}

export async function refreshPluginServiceContent(
  host: PluginServiceContentLifecycleHost,
  enabled: boolean,
  devPaths: string[],
  consentLists: PluginConsentLists
): Promise<void> {
  if (host.isDisposed()) {
    return
  }
  host.setReady(false)
  host.contentVerifier.clear()
  if (!enabled) {
    host.panels.revokeAll()
  }
  const optional = enabled
    ? await discoverPlugins({
        pluginsDir: getUserPluginsDir(host.options.userDataPath),
        devPluginPaths: devPaths,
        hostVersion: host.options.hostVersion
      })
    : []
  await host.bundledData.refresh()
  const next = host.bundledData.discovery(optional)
  if (host.isDisposed()) {
    return
  }
  // Publish identity before shutdown so triggers cannot restart old code.
  host.installed.discovered = next
  await host.contentPacks.reconcile(
    host.bundledData.content(
      next,
      enabled,
      consentLists,
      host.options.getDisabledBundledDataPlugins?.()
    ),
    (plugin) => host.bundledData.owns(plugin) || isPluginApproved(enabled, plugin, consentLists),
    host.options.getKeybindings?.()
  )
  host.setReady(true)
  const nextSpecs = collectApprovedWorkerSpecs(next, (plugin) => host.isRuntimeApproved(plugin))
  // Notify before slow shutdown so feature-off unmounts panels immediately.
  host.notifyChanged(true)
  await host.workerController.reconcile(nextSpecs)
  if (host.isDisposed()) {
    return
  }
  host.housekeeping.sync({
    enabled,
    devPaths,
    reapIdle: () => host.workerController.reapIdle(),
    refresh: () => void host.scheduleRefresh()
  })
  host.notifyChanged(false)
}

export async function reconcilePluginServiceContent(
  host: PluginServiceContentLifecycleHost
): Promise<void> {
  host.setReady(false)
  await host.contentPacks.reconcile(
    host.bundledData.content(
      host.installed.discovered,
      host.options.isPluginSystemEnabled(),
      snapshotPluginConsentLists(host.options),
      host.options.getDisabledBundledDataPlugins?.()
    ),
    (plugin) => host.activationState(plugin) === 'approved',
    host.options.getKeybindings?.()
  )
  host.setReady(true)
  const nextSpecs = collectApprovedWorkerSpecs(host.installed.discovered, (plugin) =>
    host.isRuntimeApproved(plugin)
  )
  await host.workerController.reconcile(nextSpecs)
  host.notifyChanged(true)
}
