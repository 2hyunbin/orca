import { useRef, useState } from 'react'
import type {
  PluginEnvironmentProviderSavedEntry,
  PluginEnvironmentProviderSavedHistory
} from '../../../../shared/plugins/plugin-environment-provider-saved-history-api'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { PluginEnvironmentMigrationInventory } from './PluginEnvironmentMigrationInventory'
import { PluginEnvironmentOperationHistory } from './PluginEnvironmentOperationHistory'

export function PluginEnvironmentSavedProviderCard({
  entry
}: {
  entry: PluginEnvironmentProviderSavedEntry
}): React.JSX.Element {
  const [history, setHistory] = useState<PluginEnvironmentProviderSavedHistory | null>(null)
  const [offset, setOffset] = useState(0)
  const [count, setCount] = useState(25)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const mounted = useMountedRef()
  const load = async (next: number): Promise<void> => {
    const read = window.api.plugins.savedEnvironmentProviderSnapshot
    if (pending.current || !read) {
      return
    }
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      const result = await read({ providerId: entry.providerId, offset: next })
      if (
        result.snapshot.binding.providerId !== entry.providerId ||
        result.snapshot.binding.executionHostId !== entry.executionHostId ||
        (next === 0 && result.snapshot.binding.contextId !== entry.contextId)
      ) {
        throw new Error('Saved provider selection changed')
      }
      if (mounted.current) {
        setHistory(result)
        setOffset(next)
        setCount(25)
      }
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  return (
    <Card data-saved-environment-provider-id={entry.providerId}>
      <CardHeader>
        <CardTitle className="break-words">{entry.providerId}</CardTitle>
        <p className="break-words font-mono text-xs text-muted-foreground">{entry.contextId}</p>
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentSavedProviderCard.readonly',
            'Saved history · provider inactive. Enable and review this provider in Plugins to refresh or manage these machines.'
          )}
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(offset)}>
            {translate(
              'auto.components.settings.PluginEnvironmentSavedProviderCard.show',
              'Show saved inventory'
            )}
          </Button>
          {busy ? <p role="status">{translate('common.loading', 'Loading…')}</p> : null}
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              {translate(
                'auto.components.settings.PluginEnvironmentSavedProviderCard.failed',
                'Could not read saved history. Refresh providers and try again; the saved record is kept.'
              )}
            </p>
          ) : null}
          {history ? (
            <>
              <p className="break-words font-mono text-xs">{history.snapshot.binding.contextId}</p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentSavedProviderCard.observation',
                  'Last recorded inventory and operations. Connection loss or a missing row does not establish machine deletion.'
                )}
              </p>
              {history.snapshot.resources.length ? (
                <PluginEnvironmentMigrationInventory
                  resources={history.snapshot.resources.slice(0, count)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginEnvironmentSavedProviderCard.empty',
                    'No machines have been recorded for this configuration.'
                  )}
                </p>
              )}
              {count < history.snapshot.resources.length ? (
                <Button variant="ghost" size="xs" onClick={() => setCount(count + 25)}>
                  {translate(
                    'auto.components.settings.PluginEnvironmentSavedProviderCard.more',
                    'Show more machines'
                  )}
                </Button>
              ) : null}
              <PluginEnvironmentOperationHistory
                operations={history.snapshot.operations}
                busy={false}
              />
              {history.previousCount ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || offset === 0}
                    onClick={() => void load(offset - 1)}
                  >
                    {translate(
                      'auto.components.settings.PluginEnvironmentPreviousHistory.newer',
                      'Newer configuration'
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || offset >= history.previousCount}
                    onClick={() => void load(offset + 1)}
                  >
                    {translate(
                      'auto.components.settings.PluginEnvironmentPreviousHistory.older',
                      'Older configuration'
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
