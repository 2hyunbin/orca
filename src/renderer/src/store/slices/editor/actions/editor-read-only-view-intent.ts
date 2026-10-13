import type { OpenFile } from '../types/open-file'

export function resolveExistingEditorViewIntent(
  existing: OpenFile,
  incoming: Omit<OpenFile, 'id' | 'isDirty'>
): Pick<OpenFile, 'readOnly' | 'liveTail' | 'pluginViewer' | 'pluginViewerUserSelectedFile'> {
  if (incoming.mode === 'plugin-viewer' || incoming.mode === 'file-opening') {
    const sourceView = incoming.pluginViewer?.sourceView
    const previous = existing.pluginViewer
    const changed =
      sourceView !== undefined &&
      (sourceView.readOnly !== previous?.sourceView?.readOnly ||
        sourceView.liveTail !== previous?.sourceView?.liveTail)
    return {
      readOnly: true,
      liveTail: undefined,
      pluginViewerUserSelectedFile:
        incoming.pluginViewerUserSelectedFile ?? existing.pluginViewerUserSelectedFile,
      pluginViewer: changed && previous ? { ...previous, sourceView } : previous
    }
  }
  // A deliberate editable open upgrades a log; View Log never downgrades an editable tab.
  const readOnly = existing.readOnly === true && incoming.readOnly === true ? true : undefined
  return {
    readOnly,
    liveTail: readOnly && incoming.liveTail === true ? true : undefined,
    pluginViewer: existing.pluginViewer,
    pluginViewerUserSelectedFile: undefined
  }
}
