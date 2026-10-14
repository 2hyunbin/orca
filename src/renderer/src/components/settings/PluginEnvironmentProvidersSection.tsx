import { usePluginEnvironmentHost } from './plugin-environment-host-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { PluginEnvironmentProviderSavedEntry } from '../../../../shared/plugins/plugin-environment-provider-saved-history-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { PluginEnvironmentProviderAccountDialog } from './PluginEnvironmentProviderAccountDialog'
import { PluginEnvironmentProviderCard } from './PluginEnvironmentProviderCard'
import { PluginEnvironmentSavedProviderCard } from './PluginEnvironmentSavedProviderCard'

export function PluginEnvironmentProvidersSection({
  onBrowsePlugins
}: {
  onBrowsePlugins(): void
}): React.JSX.Element {
  const { api: providerApi, hostLabel } = usePluginEnvironmentHost()
  const [providers, setProviders] = useState<PluginEnvironmentProviderEntry[]>([])
  const [saved, setSaved] = useState<PluginEnvironmentProviderSavedEntry[]>([])
  const [savedError, setSavedError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [setup, setSetup] = useState<PluginEnvironmentProviderEntry | null>(null)
  const mounted = useMountedRef()
  const generation = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const attempt = ++generation.current
    setLoading(true)
    try {
      const list = providerApi.listEnvironmentProviders
      if (!list) {
        throw new Error('Unsupported provider host')
      }
      const [active, historical] = await Promise.allSettled([
        list(),
        providerApi.listSavedEnvironmentProviders?.() ?? Promise.resolve([])
      ])
      if (mounted.current && generation.current === attempt) {
        setSaved(historical.status === 'fulfilled' ? historical.value : [])
        setSavedError(historical.status === 'rejected')
      }
      if (active.status === 'rejected') {
        throw active.reason
      }
      if (mounted.current && generation.current === attempt) {
        setProviders(active.value)
        setError(null)
      }
    } catch {
      if (mounted.current && generation.current === attempt) {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.loadError',
            'Could not load environment providers. Refresh after checking that this Orca host and your enabled plugins support providers.'
          )
        )
      }
    } finally {
      if (mounted.current && generation.current === attempt) {
        setLoading(false)
      }
    }
  }, [providerApi, mounted])
  useEffect(() => {
    void refresh()
    const stop = providerApi.onChanged((event) => {
      if (event.contentPacksChanged || event.environmentProviderId) {
        void refresh()
      }
    })
    return () => {
      generation.current += 1
      stop()
    }
  }, [providerApi, refresh])
  const searchLabel = translate(
    'auto.components.settings.PluginEnvironmentProvidersSection.search',
    'Search environment providers'
  )
  const normalized = query.trim().toLocaleLowerCase()
  const visible = providers.filter((provider) =>
    `${provider.name} ${provider.pluginKey} ${provider.description}`
      .toLocaleLowerCase()
      .includes(normalized)
  )
  const activeIds = new Set(providers.map((provider) => provider.providerId))
  const inactiveSaved = saved.filter((entry) => !activeIds.has(entry.providerId))
  const visibleSaved = inactiveSaved.filter((entry) =>
    `${entry.providerId} ${entry.contextId}`.toLocaleLowerCase().includes(normalized)
  )
  return (
    <section
      aria-label={translate(
        'auto.components.settings.PluginEnvironmentProvidersSection.title',
        'Environment providers'
      )}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.title',
              'Environment providers'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.description',
              'Manage existing development machines and temporary sandboxes through your company’s provider.'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.host',
              'Provider commands run on {{host}}.',
              { host: hostLabel }
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="xs" onClick={onBrowsePlugins}>
            {translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.browse',
              'Browse plugins'
            )}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.refresh',
              'Refresh providers'
            )}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {providers.length + inactiveSaved.length > 1 ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={searchLabel}
          placeholder={searchLabel}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.loading',
            'Loading providers…'
          )}
        </p>
      ) : null}
      {!loading && !error && providers.length + inactiveSaved.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.empty',
            'Install and enable an environment provider in Plugins to get started.'
          )}
        </p>
      ) : null}
      {!loading &&
      providers.length + inactiveSaved.length > 0 &&
      visible.length + visibleSaved.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.noMatches',
            'No providers match your search.'
          )}
        </p>
      ) : null}
      {visible.map((provider) => (
        <PluginEnvironmentProviderCard
          key={`${provider.providerId}:${provider.review.reviewRevision}:${provider.configuration.status}:${'contextId' in provider.configuration ? provider.configuration.contextId : ''}`}
          provider={provider}
          onSetUp={() => setSetup(provider)}
        />
      ))}
      {savedError ? (
        <p role="alert" className="text-sm text-destructive">
          {translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.savedError',
            'Could not load saved provider history. The saved files are kept; refresh to try again.'
          )}
        </p>
      ) : null}
      {visibleSaved.map((entry) => (
        <PluginEnvironmentSavedProviderCard
          key={`${entry.providerId}:${entry.contextId}:${entry.configuredAt}`}
          entry={entry}
        />
      ))}
      {setup ? (
        <PluginEnvironmentProviderAccountDialog
          provider={setup}
          onClose={() => setSetup(null)}
          onConfigured={(next) => {
            generation.current += 1
            setProviders(next)
            setLoading(false)
            setError(null)
          }}
        />
      ) : null}
    </section>
  )
}
