import { z } from 'zod'
import {
  pluginMarketplaceManagementInputs,
  pluginInstalledSelectionSchema
} from './plugin-marketplace-management-api'
import { pluginConsentRequestSchema } from './plugin-consent-request'
import { bundledDataPluginKeySchema } from './plugin-bundled-data-state'
import { isAllowedPluginGitUrl } from './plugin-install-lockfile'
import { normalizeUiLanguage } from '../ui-language'
import type { GlobalSettings } from '../global-settings-types'
import type { PluginLanguagePackRegistration } from './plugin-language-pack-artifact'
import type { PluginsApi } from '../../preload/api/plugin-host-api'

export const PLUGIN_MANAGEMENT_RUNTIME_CAPABILITY = 'plugins.management.v1' as const
export const pluginManagementInstallSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local-path'), path: z.string().min(1).max(4096) }),
  z.strictObject({
    kind: z.literal('git'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(32 * 1024)
      .refine(isAllowedPluginGitUrl),
    ref: z.string().trim().min(1).max(4096)
  })
])
export const pluginManagementSettingsSchema = z.strictObject({
  pluginSystemEnabled: z.boolean().optional(),
  devPluginPaths: z.array(z.string().min(1).max(4096)).max(64).optional(),
  uiLanguage: z.string().min(1).max(256).transform(normalizeUiLanguage).optional(),
  terminalThemeDark: z.string().min(1).max(256).optional(),
  terminalThemeLight: z.string().min(1).max(256).optional()
})
export type PluginManagementSettings = Pick<
  GlobalSettings,
  | 'pluginSystemEnabled'
  | 'devPluginPaths'
  | 'uiLanguage'
  | 'theme'
  | 'terminalThemeDark'
  | 'terminalThemeLight'
  | 'terminalUseSeparateLightTheme'
>
export const pluginManagementInputs = {
  ...pluginMarketplaceManagementInputs,
  state: z.strictObject({}),
  updateSettings: pluginManagementSettingsSchema,
  list: z.strictObject({}),
  refresh: z.strictObject({}),
  consent: pluginConsentRequestSchema,
  setEnabled: pluginInstalledSelectionSchema.extend({ enabled: z.boolean() }),
  install: pluginManagementInstallSchema,
  remove: pluginInstalledSelectionSchema,
  getLogs: pluginInstalledSelectionSchema,
  listLanguagePacks: z.strictObject({}),
  listTerminalThemes: z.strictObject({}),
  listBundledData: z.strictObject({}),
  setBundledDataEnabled: z.strictObject({
    pluginKey: bundledDataPluginKeySchema,
    enabled: z.boolean()
  })
}
type ApiMethod = Exclude<keyof typeof pluginManagementInputs, 'state' | 'updateSettings'>
export type PluginCatalogLanguageMetadata = Omit<PluginLanguagePackRegistration, 'catalog'>
export type PluginManagementResults = {
  [Method in ApiMethod]: Method extends 'listLanguagePacks'
    ? PluginCatalogLanguageMetadata[]
    : Awaited<ReturnType<NonNullable<PluginsApi[Method]>>>
} & { state: PluginManagementSettings; updateSettings: PluginManagementSettings }
export type PluginManagementMethod = keyof PluginManagementResults
export type PluginManagementInput<Method extends PluginManagementMethod> = z.input<
  (typeof pluginManagementInputs)[Method]
>

function request<Method extends PluginManagementMethod, Input extends z.ZodType>(
  method: Method,
  input: Input
) {
  return z.strictObject({ runtimeId: z.string().min(1).max(256), method: z.literal(method), input })
}
export const pluginManagementRequestSchema = z.discriminatedUnion('method', [
  request('state', pluginManagementInputs.state),
  request('updateSettings', pluginManagementInputs.updateSettings),
  request('list', pluginManagementInputs.list),
  request('refresh', pluginManagementInputs.refresh),
  request('consent', pluginManagementInputs.consent),
  request('setEnabled', pluginManagementInputs.setEnabled),
  request('install', pluginManagementInputs.install),
  request('remove', pluginManagementInputs.remove),
  request('getLogs', pluginManagementInputs.getLogs),
  request('listLanguagePacks', pluginManagementInputs.listLanguagePacks),
  request('listTerminalThemes', pluginManagementInputs.listTerminalThemes),
  request('listBundledData', pluginManagementInputs.listBundledData),
  request('setBundledDataEnabled', pluginManagementInputs.setBundledDataEnabled),
  request('listMarketplaces', pluginManagementInputs.listMarketplaces),
  request('addMarketplace', pluginManagementInputs.addMarketplace),
  request('removeMarketplace', pluginManagementInputs.removeMarketplace),
  request('refreshMarketplaces', pluginManagementInputs.refreshMarketplaces),
  request('listMarketplacePlugins', pluginManagementInputs.listMarketplacePlugins),
  request('previewMarketplacePlugin', pluginManagementInputs.previewMarketplacePlugin),
  request('installMarketplacePlugin', pluginManagementInputs.installMarketplacePlugin),
  request('installMarketplaceDataPlugin', pluginManagementInputs.installMarketplaceDataPlugin),
  request('approveMarketplaceUpdate', pluginManagementInputs.approveMarketplaceUpdate),
  request('previewMarketplaceUpdate', pluginManagementInputs.previewMarketplaceUpdate),
  request('rollbackMarketplacePlugin', pluginManagementInputs.rollbackMarketplacePlugin)
])
export type PluginManagementRequest = z.infer<typeof pluginManagementRequestSchema>
