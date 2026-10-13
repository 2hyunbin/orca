import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { PluginEnvironmentProviderAccountDialog } from './PluginEnvironmentProviderAccountDialog'
import { PluginEnvironmentProviderCard } from './PluginEnvironmentProviderCard'

export function PluginEnvironmentProvidersSection({
  onBrowsePlugins
}: {
  onBrowsePlugins(): void
}): React.JSX.Element {
  const [providers, setProviders] = useState<PluginEnvironmentProviderEntry[]>([])
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
      const list = window.api.plugins.listEnvironmentProviders
      if (!list) {
        throw new Error('Unsupported provider host')
      }
      const next = await list()
      if (mounted.current && generation.current === attempt) {
        setProviders(next)
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
  }, [mounted])
  useEffect(() => {
    void refresh()
    const stop = window.api.plugins.onChanged((event) => {
      if (event.contentPacksChanged || event.environmentProviderId) {
        void refresh()
      }
    })
    return () => {
      generation.current += 1
      stop()
    }
  }, [refresh])
  const normalized = query.trim().toLocaleLowerCase()
  const visible = providers.filter((provider) =>
    `${provider.name} ${provider.pluginKey} ${provider.description}`
      .toLocaleLowerCase()
      .includes(normalized)
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
              { host: getLocalExecutionHostLabel() }
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
      {providers.length > 1 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={translate(
              'auto.components.settings.PluginEnvironmentProvidersSection.search',
              'Search environment providers'
            )}
          />
        </div>
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
      {!loading && !error && providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentProvidersSection.empty',
            'Install and enable an environment provider in Plugins to get started.'
          )}
        </p>
      ) : null}
      {!loading && providers.length > 0 && visible.length === 0 ? (
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
