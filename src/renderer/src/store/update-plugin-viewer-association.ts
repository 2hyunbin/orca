import { useAppStore } from '@/store'
import {
  pluginViewerAssociationSelectorSchema,
  pluginViewerChoiceSchema,
  setPluginViewerAssociation,
  type PluginViewerAssociationSelector
} from '../../../shared/plugins/plugin-viewer-associations'

let pending: Promise<void> = Promise.resolve()

export function updatePluginViewerAssociation(
  selector: PluginViewerAssociationSelector,
  viewerKey: string,
  signal?: AbortSignal
): Promise<void> {
  const captured = pluginViewerAssociationSelectorSchema.parse(selector)
  if (viewerKey !== 'auto') {
    pluginViewerChoiceSchema.parse(viewerKey)
  }
  const save = pending.then(async () => {
    if (signal?.aborted) {
      throw new Error('source closed')
    }
    const state = useAppStore.getState()
    if (!state.settings) {
      throw new Error('settings unavailable')
    }
    await state.updateSettingsOrThrow({
      pluginViewerAssociations: setPluginViewerAssociation(
        state.settings.pluginViewerAssociations ?? [],
        captured,
        viewerKey
      )
    })
  })
  pending = save.catch(() => {})
  return save
}
