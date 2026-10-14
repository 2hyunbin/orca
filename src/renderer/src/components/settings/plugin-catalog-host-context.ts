import { createContext, useContext } from 'react'
import type { PluginCatalogHostApi } from '@/runtime/plugin-catalog-host-client'
import type {
  PluginManagementSettings,
  PluginCatalogLanguageMetadata
} from '../../../../shared/plugins/plugin-management-api'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/plugin-terminal-theme-artifact'

export type PluginCatalogHost = {
  api: PluginCatalogHostApi
  hostLabel: string
  settings: PluginManagementSettings
  languagePacks: PluginCatalogLanguageMetadata[]
  terminalThemes: PluginTerminalThemeRegistration[]
  updateSettings(updates: Partial<PluginManagementSettings>): Promise<void>
}
export const PluginCatalogHostContext = createContext<PluginCatalogHost | null>(null)
export function usePluginCatalogHost() {
  return useContext(PluginCatalogHostContext)
}
export function usePluginCatalogApi(): PluginCatalogHostApi {
  return usePluginCatalogHost()?.api ?? window.api.plugins
}
