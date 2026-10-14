import { usePluginEnvironmentHost } from './plugin-environment-host-context'
import { useRef, useState } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { PluginEnvironmentProviderHistory } from '../../../../shared/plugins/plugin-environment-provider-history-api'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { PluginEnvironmentMigrationInventory } from './PluginEnvironmentMigrationInventory'
import {
  environmentOperationActionLabel,
  environmentOperationOutcomeLabel
} from './plugin-environment-operation-copy'

export function PluginEnvironmentPreviousHistory({
  provider,
  count
}: {
  provider: PluginEnvironmentProviderEntry
  count: number
}): React.JSX.Element | null {
  const { api: providerApi } = usePluginEnvironmentHost()
  const [history, setHistory] = useState<PluginEnvironmentProviderHistory>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useMountedRef()
  const [error, setError] = useState(false)
  const load = async (page: number): Promise<void> => {
    const read = providerApi.previousEnvironmentProviderSnapshot
    const configured = provider.configuration
    if (pending.current || !read || !('contextId' in configured)) {
      return
    }
    pending.current = true
    setBusy(true)
    setError(false)
    try {
      const result = await read({
        review: { ...provider.review, contextId: configured.contextId },
        offset: page
      })
      if (mounted.current) {
        setHistory(result)
        setOffset(page)
      }
    } catch {
      if (mounted.current) {
        setError(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  if (!count) {
    return null
  }
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load(offset)}>
        {translate(
          'auto.components.settings.PluginEnvironmentPreviousHistory.show',
          'Previous configuration history'
        )}{' '}
        ({count})
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {translate(
            'auto.components.settings.PluginEnvironmentPreviousHistory.error',
            'Could not read previous configuration history. The saved record has not been reset.'
          )}
        </p>
      ) : null}
      {history ? (
        <div className="space-y-3">
          <p className="break-words font-mono text-xs text-muted-foreground">
            {history.snapshot.binding.contextId}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentPreviousHistory.readonly',
              'Read-only history from a previous account or source. These rows do not grant current machine access; missing machines are not assumed deleted.'
            )}
          </p>
          <PluginEnvironmentMigrationInventory resources={history.snapshot.resources} />
          {history.snapshot.operations
            .slice(-10)
            .toReversed()
            .map((operation) => (
              <p key={operation.operationId} className="break-words text-xs text-muted-foreground">
                {environmentOperationActionLabel(operation.action)} ·{' '}
                {environmentOperationOutcomeLabel(operation)}
                <br />
                {operation.operationId}
              </p>
            ))}
          <div className="flex gap-2">
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
              disabled={busy || offset + 1 >= count}
              onClick={() => void load(offset + 1)}
            >
              {translate(
                'auto.components.settings.PluginEnvironmentPreviousHistory.older',
                'Older configuration'
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
