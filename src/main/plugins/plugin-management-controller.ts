import {
  pluginManagementRequestSchema,
  type PluginManagementRequest,
  type PluginManagementSettings
} from '../../shared/plugins/plugin-management-api'
import type { PluginService } from './plugin-service'
import type {
  PluginMarketplaceProfileStore,
  PluginMarketplaceControllerServices
} from './plugin-marketplace-controller'
import { PluginMarketplaceController } from './plugin-marketplace-controller'
import { listPluginsForClients } from './plugin-client-list'
import { applyPluginConsent, applyPluginEnablement } from './plugin-enablement'
import { applyBundledDataEnablement } from './plugin-bundled-data-enablement'
import { installPluginForHost, removePluginForHost } from './plugin-install-controller'

export class PluginManagementController {
  private readonly marketplace
  private readonly lifetime = new AbortController()
  private readonly background = new Set<Promise<unknown>>()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(
    private readonly plugins: PluginService,
    private readonly store: PluginMarketplaceProfileStore,
    services: PluginMarketplaceControllerServices
  ) {
    this.marketplace = new PluginMarketplaceController(plugins, services, store)
  }

  async call(raw: unknown, owner: AbortSignal) {
    const request = pluginManagementRequestSchema.parse(raw)
    const signal = AbortSignal.any([owner, this.lifetime.signal])
    signal.throwIfAborted()
    if (this.pending.size >= 8) {
      throw new Error('Too many plugin management requests')
    }
    const task = this.perform(request, signal)
    this.pending.add(task)
    try {
      const result = await task
      signal.throwIfAborted()
      return result
    } finally {
      this.pending.delete(task)
    }
  }

  seedOfficialSource(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const task = this.marketplace.seedOfficialSource()
    this.background.add(task)
    return task.finally(() => this.background.delete(task))
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending, ...this.background])
  }

  private state(): PluginManagementSettings {
    const settings = this.store.getSettings()
    return {
      pluginSystemEnabled: settings.pluginSystemEnabled,
      devPluginPaths: settings.devPluginPaths,
      uiLanguage: settings.uiLanguage,
      theme: settings.theme,
      terminalThemeDark: settings.terminalThemeDark,
      terminalThemeLight: settings.terminalThemeLight,
      terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme
    }
  }

  private async perform(request: PluginManagementRequest, signal: AbortSignal) {
    await this.plugins.whenReady()
    signal.throwIfAborted()
    const assertCurrent = (): void => signal.throwIfAborted()
    switch (request.method) {
      case 'state':
        return this.state()
      case 'updateSettings':
        this.store.updateSettings(request.input, { notifyListeners: true })
        await this.plugins.refresh()
        return this.state()
      case 'list':
        return listPluginsForClients(this.plugins)
      case 'refresh':
        await this.plugins.refresh()
        return listPluginsForClients(this.plugins)
      case 'consent':
        await applyPluginConsent({
          store: this.store,
          pluginService: this.plugins,
          ...request.input,
          assertCurrent
        })
        return listPluginsForClients(this.plugins)
      case 'setEnabled':
        await applyPluginEnablement({
          store: this.store,
          pluginService: this.plugins,
          ...request.input
        })
        return listPluginsForClients(this.plugins)
      case 'install':
        return installPluginForHost(this.plugins, request.input)
      case 'remove':
        return removePluginForHost(this.plugins, this.store, request.input.pluginKey)
      case 'getLogs':
        return this.plugins.getLogs(request.input.pluginKey)
      case 'listTerminalThemes':
        return this.plugins.contentPacks.terminalThemes.list()
      case 'listBundledData':
        return this.plugins.listBundledData()
      case 'setBundledDataEnabled':
        await applyBundledDataEnablement({
          store: this.store,
          pluginService: this.plugins,
          ...request.input
        })
        return this.plugins.listBundledData()
      case 'listMarketplaces':
        return this.marketplace.listMarketplaces()
      case 'addMarketplace':
        return this.marketplace.addMarketplace(request.input)
      case 'removeMarketplace':
        return this.marketplace.removeMarketplace(request.input)
      case 'refreshMarketplaces':
        return this.marketplace.refreshMarketplaces(request.input)
      case 'listMarketplacePlugins':
        return this.marketplace.listMarketplacePlugins()
      case 'previewMarketplacePlugin':
        return this.marketplace.previewMarketplacePlugin(request.input)
      case 'installMarketplacePlugin':
        return this.marketplace.installMarketplacePlugin(request.input)
      case 'installMarketplaceDataPlugin':
        return this.marketplace.installMarketplaceDataPlugin(
          request.input,
          undefined,
          assertCurrent
        )
      case 'approveMarketplaceUpdate':
        return this.marketplace.approveMarketplaceUpdate(request.input, undefined, assertCurrent)
      case 'previewMarketplaceUpdate':
        return this.marketplace.previewMarketplaceUpdate(request.input)
      case 'rollbackMarketplacePlugin':
        return this.marketplace.rollbackMarketplacePlugin(request.input)
    }
  }
}
