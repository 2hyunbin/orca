import { ipcRenderer } from 'electron'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../../shared/plugins/plugin-consent-request'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import { pluginViewerUnavailableSchema } from '../../shared/plugins/plugin-viewer-unavailable'
import type {
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PreloadApi
} from '../api-types'

export const pluginsApi = {
  list: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:list'),
  prepareEnvironmentProviderSsh: (input) =>
    ipcRenderer.invoke('plugins:prepareEnvironmentProviderSsh', input),
  saveEnvironmentProviderSsh: (input) =>
    ipcRenderer.invoke('plugins:saveEnvironmentProviderSsh', input),
  recoverEnvironmentProvider: (input) =>
    ipcRenderer.invoke('plugins:recoverEnvironmentProvider', input),
  prepareEnvironmentProviderMigration: (input) =>
    ipcRenderer.invoke('plugins:prepareEnvironmentProviderMigration', input),
  commitEnvironmentProviderMigration: (input) =>
    ipcRenderer.invoke('plugins:commitEnvironmentProviderMigration', input),
  previousEnvironmentProviderSnapshot: (input) =>
    ipcRenderer.invoke('plugins:previousEnvironmentProviderSnapshot', input),
  listEnvironmentProviders: () => ipcRenderer.invoke('plugins:listEnvironmentProviders'),
  listSavedEnvironmentProviders: () => ipcRenderer.invoke('plugins:listSavedEnvironmentProviders'),
  savedEnvironmentProviderSnapshot: (input) =>
    ipcRenderer.invoke('plugins:savedEnvironmentProviderSnapshot', input),
  configureEnvironmentProvider: (review) =>
    ipcRenderer.invoke('plugins:configureEnvironmentProvider', review),
  environmentProviderSnapshot: (review) =>
    ipcRenderer.invoke('plugins:environmentProviderSnapshot', review),
  executeEnvironmentProvider: (input) =>
    ipcRenderer.invoke('plugins:executeEnvironmentProvider', input),
  cancelEnvironmentProvider: (input) =>
    ipcRenderer.invoke('plugins:cancelEnvironmentProvider', input),
  listThemes: () => ipcRenderer.invoke('plugins:listThemes'),
  listIconThemes: () => ipcRenderer.invoke('plugins:listIconThemes'),
  loadIconTheme: (id) => ipcRenderer.invoke('plugins:loadIconTheme', id),
  listTerminalThemes: () => ipcRenderer.invoke('plugins:listTerminalThemes'),
  listLanguagePacks: () => ipcRenderer.invoke('plugins:listLanguagePacks'),
  getBundledDataAliases: () => ipcRenderer.invoke('plugins:getBundledDataAliases'),
  listBundledData: () => ipcRenderer.invoke('plugins:listBundledData'),
  setBundledDataEnabled: (args) => ipcRenderer.invoke('plugins:setBundledDataEnabled', args),
  listSyntaxPacks: (options) => ipcRenderer.invoke('plugins:listSyntaxPacks', options),
  listFileViewers: () => ipcRenderer.invoke('plugins:listFileViewers'),
  openViewerTab: (request) => ipcRenderer.invoke('plugins:openViewerTab', request),
  closeViewerTab: (lease) => ipcRenderer.invoke('plugins:closeViewerTab', lease),
  onViewerUnavailable: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = pluginViewerUnavailableSchema.safeParse(value)
      if (parsed.success) {
        callback(parsed.data)
      }
    }
    ipcRenderer.on('plugins:viewerUnavailable', listener)
    return () => ipcRenderer.removeListener('plugins:viewerUnavailable', listener)
  },
  loadSyntaxPack: (args) => ipcRenderer.invoke('plugins:loadSyntaxPack', args),
  consent: (args: PluginConsentRequest): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:consent', args),
  setEnabled: (args: { pluginKey: string; enabled: boolean }): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:setEnabled', args),
  readPanelEntry: (args: {
    pluginKey: string
    panelId: string
  }): Promise<PluginPanelEntry | null> => ipcRenderer.invoke('plugins:readPanelEntry', args),
  invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
    ipcRenderer.invoke('plugins:invokeCommand', args),
  panelAction: (args: {
    sessionToken: string
    action: string
    params?: unknown
  }): Promise<PluginPanelActionOutcome> => ipcRenderer.invoke('plugins:panelAction', args),
  install: (source: PluginHostInstallSource): Promise<PluginHostInstallResult> =>
    ipcRenderer.invoke('plugins:install', source),
  listMarketplaces: () => ipcRenderer.invoke('plugins:listMarketplaces'),
  addMarketplace: (source) => ipcRenderer.invoke('plugins:addMarketplace', source),
  removeMarketplace: (args) => ipcRenderer.invoke('plugins:removeMarketplace', args),
  refreshMarketplaces: (args = {}) => ipcRenderer.invoke('plugins:refreshMarketplaces', args),
  listMarketplacePlugins: () => ipcRenderer.invoke('plugins:listMarketplacePlugins'),
  previewMarketplacePlugin: (args) => ipcRenderer.invoke('plugins:previewMarketplacePlugin', args),
  installMarketplaceDataPlugin: (args) =>
    ipcRenderer.invoke('plugins:installMarketplaceDataPlugin', args),
  installMarketplacePlugin: (preview) =>
    ipcRenderer.invoke('plugins:installMarketplacePlugin', preview),
  approveMarketplaceUpdate: (request) =>
    ipcRenderer.invoke('plugins:approveMarketplaceUpdate', request),
  previewMarketplaceUpdate: (args) => ipcRenderer.invoke('plugins:previewMarketplaceUpdate', args),
  rollbackMarketplacePlugin: (args) =>
    ipcRenderer.invoke('plugins:rollbackMarketplacePlugin', args),
  remove: (args: { pluginKey: string }): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:remove', args),
  getLogs: (args: { pluginKey: string }): Promise<PluginHostLogLine[]> =>
    ipcRenderer.invoke('plugins:getLogs', args),
  refresh: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:refresh'),
  onChanged: (callback): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: PluginChangeEvent): void =>
      callback(change)
    ipcRenderer.on('plugins:changed', listener)
    return () => {
      ipcRenderer.removeListener('plugins:changed', listener)
    }
  }
} satisfies PreloadApi['plugins']
