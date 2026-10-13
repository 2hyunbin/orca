import { z } from 'zod'

export const pluginViewerSourceViewSchema = z.strictObject({
  readOnly: z.boolean(),
  liveTail: z.boolean().optional()
})
export type PluginViewerSourceView = z.infer<typeof pluginViewerSourceViewSchema>

export function resolvePluginViewerSourceView(file: {
  mode: string
  readOnly?: boolean
  liveTail?: boolean
  pluginViewer?: { sourceView?: PluginViewerSourceView }
  fileOpening?: PluginViewerSourceView
}): PluginViewerSourceView {
  if (file.mode === 'file-opening') {
    return file.fileOpening ?? { readOnly: true }
  }
  if (file.mode === 'plugin-viewer') {
    // Older viewer sessions did not retain the source intent; keep their fallback read-only.
    const source = file.pluginViewer?.sourceView ?? { readOnly: true }
    return {
      readOnly: source.readOnly,
      ...(source.readOnly && source.liveTail ? { liveTail: true } : {})
    }
  }
  return {
    readOnly: file.readOnly === true,
    ...(file.readOnly && file.liveTail ? { liveTail: true } : {})
  }
}
