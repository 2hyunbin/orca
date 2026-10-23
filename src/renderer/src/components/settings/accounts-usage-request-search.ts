import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { USAGE_REQUEST_PROVIDERS } from '../../../../shared/usage-request-policy'

export const getAccountsUsageRequestSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.usageRequests.title', 'Usage requests'),
    description: translate(
      'settings.usageRequests.searchDescription',
      'Control automatic and manual provider usage checks on the selected host.'
    ),
    keywords: [
      'usage',
      'requests',
      'polling',
      'quota',
      'rate limit',
      'disable',
      'off',
      'fetch',
      'status bar',
      ...USAGE_REQUEST_PROVIDERS
    ]
  }
])
