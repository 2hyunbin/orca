import {
  environmentOperationActionLabel,
  environmentOperationObservationLabel,
  environmentOperationOutcomeLabel
} from './plugin-environment-operation-copy'
import { useState } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeJournalOperation } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { isEnvironmentRecipeOperationUnresolved } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  PluginEnvironmentRecoveryDialog,
  type PluginEnvironmentRecoveryIntent
} from './PluginEnvironmentRecoveryDialog'

export function PluginEnvironmentOperationHistory({
  provider,
  operations,
  busy,
  onInspected
}: {
  provider?: PluginEnvironmentProviderEntry
  operations: EnvironmentRecipeJournalOperation[]
  busy: boolean
  onInspected?(): void
}): React.JSX.Element | null {
  const [intent, setIntent] = useState<PluginEnvironmentRecoveryIntent | null>(null)
  const [count, setCount] = useState(10)
  if (!operations.length) {
    return null
  }
  const unresolved = operations.filter(
    (operation) => isEnvironmentRecipeOperationUnresolved(operation) && operation.action !== 'list'
  )
  const supported =
    provider?.recoverySupported &&
    provider.configuration.status === 'ready' &&
    onInspected &&
    window.api.plugins.recoverEnvironmentProvider
  return (
    <div className="space-y-3 border-t border-border pt-3">
      {unresolved.map((operation) => (
        <div
          key={operation.operationId}
          className="space-y-2"
          data-environment-operation-id={operation.operationId}
        >
          <p className="text-sm">
            {translate(
              'auto.components.settings.PluginEnvironmentOperationHistory.unresolved',
              'Unresolved machine change'
            )}
            : {environmentOperationActionLabel(operation.action)}
          </p>
          <p className="break-words font-mono text-xs text-muted-foreground">
            {operation.operationId}
          </p>
          {supported ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (provider) {
                  setIntent({
                    provider: structuredClone(provider),
                    operation: structuredClone(operation)
                  })
                }
              }}
            >
              {translate(
                'auto.components.settings.PluginEnvironmentOperationHistory.check',
                'Check with provider'
              )}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {provider
                ? translate(
                    'auto.components.settings.PluginEnvironmentOperationHistory.unsupported',
                    'This provider has no reviewed receipt command. Check its CLI or ask its maintainer for recovery support; refreshing inventory cannot settle the original change.'
                  )
                : translate(
                    'auto.components.settings.PluginEnvironmentOperationHistory.inactive',
                    'Enable and review this provider to check the unresolved change. The original operation remains saved.'
                  )}
            </p>
          )}
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginEnvironmentOperationHistory.title',
            'Operation history'
          )}{' '}
          ({operations.length})
        </summary>
        <div className="space-y-3 pt-3">
          {operations
            .slice(-count)
            .toReversed()
            .map((operation) => (
              <div
                key={operation.operationId}
                className="space-y-1"
                data-environment-history-id={operation.operationId}
              >
                <p className="text-xs">
                  {environmentOperationActionLabel(operation.action)} ·{' '}
                  {environmentOperationOutcomeLabel(operation)}
                </p>
                <p className="break-words font-mono text-xs text-muted-foreground">
                  {operation.operationId}
                </p>
                {operation.recovery ? (
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginEnvironmentOperationHistory.retained',
                      'Original observation kept'
                    )}
                    : {environmentOperationObservationLabel(operation)}
                  </p>
                ) : null}
              </div>
            ))}
          {count < operations.length ? (
            <Button variant="ghost" size="xs" onClick={() => setCount(count + 10)}>
              {translate(
                'auto.components.settings.PluginEnvironmentOperationHistory.older',
                'Show older operations'
              )}
            </Button>
          ) : null}
        </div>
      </details>
      {intent && onInspected ? (
        <PluginEnvironmentRecoveryDialog
          intent={intent}
          onClose={() => setIntent(null)}
          onInspected={onInspected}
        />
      ) : null}
    </div>
  )
}
