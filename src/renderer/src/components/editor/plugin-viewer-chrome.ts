import { translate } from '@/i18n/i18n'
import type { PluginViewerChrome } from '../../../../shared/plugins/plugin-viewer-frame-protocol'
import type { PluginViewerViewport } from '../../../../shared/plugins/plugin-viewer-surface'

export function pluginViewerChrome(
  dark: boolean,
  viewport?: PluginViewerViewport
): PluginViewerChrome {
  return {
    dark,
    viewport,
    labels: {
      loading: translate('plugins.viewer.loading', 'Opening file…'),
      empty: translate('plugins.viewer.empty', 'This document is empty.'),
      previous: translate('plugins.viewer.previous', 'Previous'),
      next: translate('plugins.viewer.next', 'Next'),
      sheet: translate('plugins.viewer.sheet', 'Sheet'),
      reset: translate('plugins.viewer.reset', 'Reset view'),
      title: translate('plugins.viewer.title', 'File viewer'),
      zoomIn: translate('plugins.viewer.zoomIn', 'Zoom in'),
      zoomOut: translate('plugins.viewer.zoomOut', 'Zoom out'),
      cachedFormula: translate(
        'plugins.viewer.cachedFormula',
        'Saved formula result. Formulas are not calculated.'
      ),
      failed: translate('plugins.viewer.failed', 'The viewer could not open this file.'),
      cellDetails: translate('plugins.viewer.cellDetails', 'Cell details'),
      cellValue: translate('plugins.viewer.cellValue', 'Cell value'),
      copy: translate('plugins.viewer.copy', 'Copy value'),
      copied: translate('plugins.viewer.copied', 'Copied'),
      copyFailed: translate(
        'plugins.viewer.copyFailed',
        'Could not copy. Select the value and copy with your keyboard.'
      ),
      close: translate('plugins.viewer.close', 'Close')
    }
  }
}
