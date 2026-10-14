import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { installMarketplaceDataPlugin } from './plugin-marketplace-data-action'
import { installReviewedMarketplaceUpdate } from './plugin-marketplace-reviewed-update'
import { pluginMarketplaceManagementInputs } from '../../shared/plugins/plugin-marketplace-management-api'

export type PluginMarketplaceControllerServices = {
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
}
export type PluginMarketplaceProfileStore = Pick<Store, 'getSettings' | 'updateSettings'>

export class PluginMarketplaceController {
  constructor(
    private readonly plugins: PluginService,
    private readonly services: PluginMarketplaceControllerServices,
    private readonly store?: PluginMarketplaceProfileStore
  ) {}

  seedOfficialSource() {
    return this.services.marketplace.seedOfficialSource()
  }
  listMarketplaces() {
    return this.services.marketplace.listSources()
  }
  addMarketplace(raw: unknown) {
    return this.services.marketplace.addSource(
      pluginMarketplaceManagementInputs.addMarketplace.parse(raw)
    )
  }
  async removeMarketplace(raw: unknown) {
    const { sourceId } = pluginMarketplaceManagementInputs.removeMarketplace.parse(raw)
    await this.services.marketplace.removeSource(sourceId)
    return this.services.marketplace.listSources()
  }
  refreshMarketplaces(raw: unknown) {
    const { sourceId } = pluginMarketplaceManagementInputs.refreshMarketplaces.parse(raw ?? {})
    return sourceId
      ? this.services.marketplace.refreshSource(sourceId).then((source) => [source])
      : this.services.marketplace.refreshAll()
  }
  listMarketplacePlugins() {
    return this.services.marketplace.listPlugins()
  }
  previewMarketplacePlugin(raw: unknown) {
    const input = pluginMarketplaceManagementInputs.previewMarketplacePlugin.parse(raw)
    return this.services.installer.preview(input.marketplaceSourceId, input.pluginKey)
  }
  async installMarketplacePlugin(raw: unknown) {
    const result = await this.services.installer.install(
      pluginMarketplaceManagementInputs.installMarketplacePlugin.parse(raw)
    )
    if (result.ok) {
      await this.plugins.refresh()
    }
    return result
  }
  installMarketplaceDataPlugin(
    raw: unknown,
    originWebContentsId?: number,
    assertCurrent?: () => void
  ) {
    const input = pluginMarketplaceManagementInputs.installMarketplaceDataPlugin.parse(raw)
    return installMarketplaceDataPlugin({
      ...input,
      ...this.services,
      pluginService: this.plugins,
      store: this.requireStore(),
      originWebContentsId,
      assertCurrent
    })
  }
  approveMarketplaceUpdate(raw: unknown, originWebContentsId?: number, assertCurrent?: () => void) {
    return installReviewedMarketplaceUpdate({
      request: pluginMarketplaceManagementInputs.approveMarketplaceUpdate.parse(raw),
      installer: this.services.installer,
      pluginService: this.plugins,
      store: this.requireStore(),
      originWebContentsId,
      assertCurrent
    })
  }
  previewMarketplaceUpdate(raw: unknown) {
    const { pluginKey } = pluginMarketplaceManagementInputs.previewMarketplaceUpdate.parse(raw)
    return this.services.installer.previewInstalledUpdate(pluginKey)
  }
  async rollbackMarketplacePlugin(raw: unknown) {
    const { pluginKey } = pluginMarketplaceManagementInputs.rollbackMarketplacePlugin.parse(raw)
    await this.plugins.deactivatePlugin(pluginKey)
    const result = await this.services.installer.rollback(pluginKey)
    if (result.ok) {
      await this.plugins.refresh()
    }
    return result
  }
  private requireStore(): PluginMarketplaceProfileStore {
    if (!this.store) {
      throw new Error('Plugin marketplace approval is unavailable on this host')
    }
    return this.store
  }
}
