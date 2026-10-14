import type { PluginsApi } from '../../../preload/api/plugin-host-api'
import type { PluginEnvironmentProviderSessionOpen } from '../../../shared/plugins/plugin-environment-provider-session'
import {
  pluginManagementInputs,
  pluginManagementRequestSchema,
  type PluginCatalogLanguageMetadata,
  type PluginManagementInput,
  type PluginManagementMethod,
  type PluginManagementResults
} from '../../../shared/plugins/plugin-management-api'
import { openPluginHostReview } from './plugin-host-review-session'

export type PluginCatalogHostApi = Omit<
  Pick<PluginsApi, Exclude<PluginManagementMethod, 'state' | 'updateSettings'> | 'onChanged'>,
  'listLanguagePacks'
> & { listLanguagePacks(): Promise<PluginCatalogLanguageMetadata[]> }

function coalesceCatalogRead<Result>(read: () => Promise<Result>): () => Promise<Result> {
  let pending: Promise<Result> | undefined
  return () => {
    pending ??= read().finally(() => {
      pending = undefined
    })
    return pending
  }
}

export async function openPluginCatalogSession(
  input: PluginEnvironmentProviderSessionOpen,
  onRetired: () => void,
  signal: AbortSignal
) {
  const invoke = window.api.plugins.callPluginManagementSession
  if (!invoke) {
    throw new Error('Update Orca to manage the selected host’s catalog')
  }
  const review = await openPluginHostReview({ ...input, purpose: 'management' }, onRetired, signal)
  const call = async <Method extends PluginManagementMethod>(
    method: Method,
    args: PluginManagementInput<Method>
  ): Promise<PluginManagementResults[Method]> => {
    review.current()
    const result = await invoke<Method>({
      sessionId: input.sessionId,
      request: pluginManagementRequestSchema.parse({
        runtimeId: input.runtimeId,
        method,
        input: args
      })
    })
    review.current()
    return result
  }
  const api: PluginCatalogHostApi = {
    list: coalesceCatalogRead(() => call('list', {})),
    refresh: () => call('refresh', {}),
    consent: (args) => call('consent', args),
    setEnabled: (args) => call('setEnabled', args),
    install: (args) => call('install', args),
    remove: (args) => call('remove', args),
    getLogs: (args) => call('getLogs', args),
    listTerminalThemes: coalesceCatalogRead(() => call('listTerminalThemes', {})),
    listLanguagePacks: coalesceCatalogRead(() => call('listLanguagePacks', {})),
    listBundledData: coalesceCatalogRead(() => call('listBundledData', {})),
    setBundledDataEnabled: (args) =>
      call('setBundledDataEnabled', pluginManagementInputs.setBundledDataEnabled.parse(args)),
    listMarketplaces: coalesceCatalogRead(() => call('listMarketplaces', {})),
    addMarketplace: (args) => call('addMarketplace', args),
    removeMarketplace: (args) => call('removeMarketplace', args),
    refreshMarketplaces: (args = {}) => call('refreshMarketplaces', args),
    listMarketplacePlugins: coalesceCatalogRead(() => call('listMarketplacePlugins', {})),
    previewMarketplacePlugin: (args) => call('previewMarketplacePlugin', args),
    installMarketplacePlugin: (args) => call('installMarketplacePlugin', args),
    installMarketplaceDataPlugin: (args) => call('installMarketplaceDataPlugin', args),
    approveMarketplaceUpdate: (args) => call('approveMarketplaceUpdate', args),
    previewMarketplaceUpdate: (args) => call('previewMarketplaceUpdate', args),
    rollbackMarketplacePlugin: (args) => call('rollbackMarketplacePlugin', args),
    onChanged: review.onChanged
  }
  return { api, call, close: review.close }
}
