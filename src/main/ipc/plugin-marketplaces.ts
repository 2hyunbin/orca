import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import type { PluginService } from '../plugins/plugin-service'
import type { Store } from '../persistence'
import {
  PluginMarketplaceController,
  type PluginMarketplaceControllerServices
} from '../plugins/plugin-marketplace-controller'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export type PluginMarketplaceHandlerServices = PluginMarketplaceControllerServices

export function registerPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices,
  store?: Store
): void {
  const controller = new PluginMarketplaceController(pluginService, services, store)
  registerPluginRendererHandler('plugins:listMarketplaces', () => controller.listMarketplaces())
  registerPluginRendererHandler('plugins:addMarketplace', (_event, input: unknown) =>
    controller.addMarketplace(input)
  )
  registerPluginRendererHandler('plugins:removeMarketplace', (_event, input: unknown) =>
    controller.removeMarketplace(input)
  )
  registerPluginRendererHandler('plugins:refreshMarketplaces', (_event, input: unknown) =>
    controller.refreshMarketplaces(input)
  )
  registerPluginRendererHandler('plugins:listMarketplacePlugins', () =>
    controller.listMarketplacePlugins()
  )
  registerPluginRendererHandler('plugins:previewMarketplacePlugin', (_event, input: unknown) =>
    controller.previewMarketplacePlugin(input)
  )
  registerPluginRendererHandler('plugins:installMarketplacePlugin', (_event, input: unknown) =>
    controller.installMarketplacePlugin(input)
  )
  if (store) {
    registerPluginRendererHandler('plugins:approveMarketplaceUpdate', (event, input: unknown) => {
      if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: 'plugin update requires the trusted application window' }
      }
      return controller.approveMarketplaceUpdate(input, event.sender.id)
    })
    registerPluginRendererHandler('plugins:installMarketplaceDataPlugin', (event, input: unknown) =>
      controller.installMarketplaceDataPlugin(input, event.sender.id)
    )
  }
  registerPluginRendererHandler('plugins:previewMarketplaceUpdate', (_event, input: unknown) =>
    controller.previewMarketplaceUpdate(input)
  )
  registerPluginRendererHandler('plugins:rollbackMarketplacePlugin', (_event, input: unknown) =>
    controller.rollbackMarketplacePlugin(input)
  )
}
