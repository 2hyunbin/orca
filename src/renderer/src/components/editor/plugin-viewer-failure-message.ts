import { translate } from '@/i18n/i18n'
import type { PluginViewerStatus } from '../../../../shared/plugins/plugin-viewer-frame-protocol'

export function pluginViewerFailureMessage(
  code: Extract<PluginViewerStatus, { type: 'error' }>['code']
): string {
  switch (code) {
    case 'unsupported_host':
      return translate(
        'plugins.viewer.unsupportedHost',
        'This connection does not support plugin file viewers yet.'
      )
    case 'stale_revision':
      return translate(
        'plugins.viewer.changed',
        'The file changed. Reload to view the latest version.'
      )
    case 'limit_exceeded':
      return translate(
        'plugins.viewer.limitExceeded',
        'This viewer reached its resource limits. Try another viewer.'
      )
    case 'unsupported_format':
      return translate(
        'plugins.viewer.unsupportedFormat',
        'This viewer does not support this file’s format or features. Try another viewer.'
      )
    case 'parse_failed':
      return translate(
        'plugins.viewer.parseFailed',
        'The viewer could not read this file. It may be damaged or use unsupported features.'
      )
    case 'unresponsive':
      return translate(
        'plugins.viewer.unresponsive',
        'The viewer stopped responding. Retry to open a new viewer session.'
      )
    case 'invalid_output':
      return translate(
        'plugins.viewer.invalidOutput',
        'The viewer returned invalid content. Try another viewer or update this plugin.'
      )
    case 'unavailable':
      return translate(
        'plugins.viewer.unavailable',
        'This viewer is unavailable. Check that its plugin is enabled and approved.'
      )
    case 'unauthorized':
      return translate(
        'plugins.viewer.unauthorized',
        'This viewer’s access has ended. Reopen the file from your workspace.'
      )
    case 'cancelled':
    case 'invalid_request':
    case 'read_failed':
      return translate('plugins.viewer.failed', 'The viewer could not open this file.')
  }
}
