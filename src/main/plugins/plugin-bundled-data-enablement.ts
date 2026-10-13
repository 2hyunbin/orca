import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import { normalizeDisabledBundledDataPlugins } from '../../shared/plugins/plugin-bundled-data-state'

export async function applyBundledDataEnablement(input: {
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  pluginService: PluginService
  pluginKey: string
  enabled: boolean
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey, enabled } = input
  if (!pluginService.listBundledData().some((pack) => pack.pluginKey === pluginKey)) {
    throw new Error('Unknown app-owned data package')
  }
  const disabled = new Set(
    normalizeDisabledBundledDataPlugins(store.getSettings().disabledBundledDataPlugins)
  )
  if (enabled) {
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledBundledDataPlugins: [...disabled] },
    {
      notifyListeners: true,
      originWebContentsId: input.originWebContentsId
    }
  )
  await pluginService.reconcileActivationState()
}
