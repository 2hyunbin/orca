import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeJournal } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'

export function usePluginEnvironmentInventory(provider: PluginEnvironmentProviderEntry) {
  const [snapshot, setSnapshot] = useState<EnvironmentRecipeJournal | null>(null)
  const [loading, setLoading] = useState(
    provider.configuration.status === 'ready' ||
      provider.configuration.status === 'migration-required'
  )
  const [readError, setReadError] = useState<string | null>(null)
  const readGeneration = useRef(0)
  const mounted = useMountedRef()
  const load = useCallback(async (): Promise<void> => {
    const configuration = provider.configuration
    if (configuration.status !== 'ready' && configuration.status !== 'migration-required') {
      return
    }
    const attempt = ++readGeneration.current
    const read = window.api.plugins.environmentProviderSnapshot
    if (!read) {
      return
    }
    setLoading(true)
    try {
      const next = await read({ ...provider.review, contextId: configuration.contextId })
      if (mounted.current && attempt === readGeneration.current) {
        setSnapshot(next)
        setReadError(null)
      }
    } catch {
      if (mounted.current && attempt === readGeneration.current) {
        setReadError(
          translate(
            'auto.components.settings.PluginEnvironmentProviderCard.readError',
            'Could not read saved machine details. Refresh the provider before trying again.'
          )
        )
      }
    } finally {
      if (mounted.current && attempt === readGeneration.current) {
        setLoading(false)
      }
    }
  }, [mounted, provider.configuration, provider.review])
  useEffect(() => {
    void load()
    const stop = window.api.plugins.onChanged((event) => {
      if (event.environmentProviderId === provider.providerId) {
        void load()
      }
    })
    return () => {
      readGeneration.current += 1
      stop()
    }
  }, [load, provider.providerId])
  return { snapshot, loading, readError, load }
}
