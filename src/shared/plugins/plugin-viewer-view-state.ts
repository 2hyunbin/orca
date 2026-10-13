import { z } from 'zod'
import { pluginViewerViewportSchema, type PluginViewerViewport } from './plugin-viewer-surface'

export const PLUGIN_VIEWER_SAVED_VIEWS = 32
export const pluginViewerTabViewportsSchema = z
  .record(z.string().min(1).max(8192), pluginViewerViewportSchema)
  .refine((views) => Object.keys(views).length <= PLUGIN_VIEWER_SAVED_VIEWS)
export type PluginViewerTabViewports = z.infer<typeof pluginViewerTabViewportsSchema>
type ViewerViewState = {
  viewport?: PluginViewerViewport
  viewportsByTab?: PluginViewerTabViewports
}

export function pluginViewerViewportForTab(
  state: ViewerViewState | undefined,
  tabId: string
): PluginViewerViewport | undefined {
  if (state?.viewportsByTab && Object.keys(state.viewportsByTab).length) {
    return Object.hasOwn(state.viewportsByTab, tabId) ? state.viewportsByTab[tabId] : undefined
  }
  return state?.viewport
}

export function withPluginViewerTabViewport(
  state: ViewerViewState,
  tabId: string,
  viewport: PluginViewerViewport
): ViewerViewState {
  const previous = Object.entries(state.viewportsByTab ?? {}).filter(([id]) => id !== tabId)
  return {
    viewport,
    viewportsByTab: Object.fromEntries([
      ...previous.slice(-(PLUGIN_VIEWER_SAVED_VIEWS - 1)),
      [tabId, viewport]
    ])
  }
}
