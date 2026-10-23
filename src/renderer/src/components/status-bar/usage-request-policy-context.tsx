import { createContext, useContext } from 'react'
import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsageRequestPolicy } from '../../../../shared/usage-request-policy'

export const UsageRequestPolicyContext = createContext<UsageRequestPolicy | undefined>(undefined)

export function UsageRequestNotice({
  provider
}: {
  provider: ProviderRateLimits
}): React.JSX.Element | null {
  const policy = useContext(UsageRequestPolicyContext)
  if (policy?.enabled[provider.provider] !== false) {
    return null
  }
  const source = provider.usageMetadata?.source ?? provider.usageMetadata?.lastSuccessfulSource
  const live = source === 'live-session'
  return (
    <p className="text-xs text-muted-foreground whitespace-normal">
      {live
        ? translate(
            'settings.usageRequests.liveNotice',
            'Usage requests disabled. Live Claude statusLine data can still update.'
          )
        : translate(
            'settings.usageRequests.cachedNotice',
            'Usage requests disabled. Shown usage is cached and may be stale.'
          )}
      {provider.updatedAt > 0 ? (
        <>
          {' '}
          {translate('settings.usageRequests.lastUpdate', 'Last update: {{time}}', {
            time: new Date(provider.updatedAt).toLocaleString()
          })}
        </>
      ) : null}
      {source ? (
        <> {translate('settings.usageRequests.source', 'Source: {{source}}', { source })}</>
      ) : null}
    </p>
  )
}
