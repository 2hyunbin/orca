import { PluginEnvironmentMigrationDialog } from './PluginEnvironmentMigrationDialog'
import { PluginEnvironmentPreviousHistory } from './PluginEnvironmentPreviousHistory'
import { usePluginEnvironmentInventory } from './use-plugin-environment-inventory'
import { PluginEnvironmentOperationHistory } from './PluginEnvironmentOperationHistory'
import {
  isEnvironmentRecipeOperationUnresolved,
  isEnvironmentRecipeResourceInventoryUnconfirmed,
  environmentRecipeRecoveredResourceId
} from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type {
  PluginEnvironmentProviderEntry,
  PluginEnvironmentProviderReview
} from '../../../../shared/plugins/plugin-environment-provider-api'
import type {
  EnvironmentRecipeAction,
  EnvironmentRecipeResource
} from '../../../../shared/environment-recipe-protocol'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { PluginEnvironmentConnectionResources } from './PluginEnvironmentConnectionResources'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import {
  PluginEnvironmentActionDialog,
  type PluginEnvironmentActionIntent
} from './PluginEnvironmentActionDialog'

function reviewedAccount(
  provider: PluginEnvironmentProviderEntry
): PluginEnvironmentProviderReview | null {
  const { configuration } = provider
  return configuration.status === 'ready' || configuration.status === 'migration-required'
    ? { ...provider.review, contextId: configuration.contextId }
    : null
}

export function PluginEnvironmentProviderCard({
  provider,
  onSetUp
}: {
  provider: PluginEnvironmentProviderEntry
  onSetUp(): void
}): React.JSX.Element {
  const { snapshot, loading, readError, load } = usePluginEnvironmentInventory(provider)
  const review = reviewedAccount(provider)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const operation = useRef<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [intent, setIntent] = useState<PluginEnvironmentActionIntent | null>(null)
  const mounted = useMountedRef()
  const run = async (
    actionIntent: PluginEnvironmentActionIntent,
    parameters: Record<string, string> = {}
  ): Promise<void> => {
    const execute = window.api.plugins.executeEnvironmentProvider
    const account = reviewedAccount(actionIntent.provider)
    if (operation.current || !execute || !account) {
      return
    }
    const operationId = createBrowserUuid()
    operation.current = operationId
    setRunning(operationId)
    setError(null)
    try {
      const action = actionIntent.action
      const resource = actionIntent.resource
      const request =
        action === 'create'
          ? {
              protocolVersion: 2 as const,
              operationId,
              providerId: account.providerId,
              contextId: account.contextId,
              action,
              parameters
            }
          : action === 'list'
            ? {
                protocolVersion: 2 as const,
                operationId,
                providerId: account.providerId,
                contextId: account.contextId,
                action
              }
            : resource
              ? {
                  protocolVersion: 2 as const,
                  operationId,
                  providerId: account.providerId,
                  contextId: account.contextId,
                  action,
                  resourceId: resource.id,
                  expectedRevision: resource.revision
                }
              : null
      if (!request) {
        return
      }
      const result = await execute({ review: account, request })
      if (result.kind !== 'executed' || result.result.kind !== 'completed') {
        throw new Error('Unresolved provider outcome')
      }
      if (result.result.response.kind === 'error') {
        throw new Error('Provider refused the operation')
      }
      if (mounted.current) {
        setIntent(null)
      }
    } catch {
      const message = translate(
        'auto.components.settings.PluginEnvironmentProviderCard.operationError',
        'The provider could not confirm this operation. Orca keeps its history and last confirmed machine state. Refresh inventory and check your company CLI before starting another change.'
      )
      if (mounted.current) {
        setError(message)
      }
      throw new Error(message)
    } finally {
      operation.current = null
      if (mounted.current) {
        setRunning(null)
        await load()
      }
    }
  }
  const pending = snapshot?.operations.find(
    (item) => item.status === 'pending' && isEnvironmentRecipeOperationUnresolved(item)
  )
  const blocked = Boolean(
    running ||
    pending ||
    snapshot?.operations.some(
      (item) => isEnvironmentRecipeOperationUnresolved(item) && item.action !== 'list'
    )
  )
  const needsInventory = snapshot?.operations.some((entry) =>
    isEnvironmentRecipeResourceInventoryUnconfirmed(entry)
  )
  const ready = provider.configuration.status === 'ready'
  const requestAction = (
    action: EnvironmentRecipeAction,
    resource?: EnvironmentRecipeResource
  ): void => {
    setIntent({ provider, action, ...(resource ? { resource } : {}) })
  }
  return (
    <article
      className="space-y-4 border-t border-border pt-4"
      data-environment-provider-id={provider.providerId}
    >
      <div className="space-y-1">
        <h4 className="text-sm font-semibold">{provider.name}</h4>
        <p className="text-sm text-muted-foreground">{provider.description}</p>
        <p className="text-xs text-muted-foreground">{provider.pluginKey}</p>
      </div>
      <div className="space-y-4">
        {provider.configuration.status === 'unconfigured' ? (
          <Button variant="outline" size="sm" onClick={onSetUp}>
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.setup',
              'Set up account'
            )}
          </Button>
        ) : null}
        {review ? (
          <p className="break-words text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.account',
              'Account: {{account}}',
              { account: review.contextId }
            )}
          </p>
        ) : null}
        {provider.configuration.status === 'migration-required' ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.migration',
              'This provider’s source or commands changed. Saved machines remain attached to the previous configuration. Verify their ownership before migrating this account.'
            )}
          </p>
        ) : null}
        {provider.configuration.status === 'unavailable' ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.unavailable',
              'This provider cannot currently manage machines. Check its account-context support and configuration in Plugins.'
            )}
          </p>
        ) : null}
        {ready ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(running || (pending && pending.action !== 'list'))}
              onClick={() => void run({ provider, action: 'list' }).catch(() => {})}
            >
              <RefreshCw />
              {translate(
                'auto.components.settings.PluginEnvironmentProviderCard.refresh',
                'Refresh inventory'
              )}
            </Button>
            {provider.actions.includes('create') ? (
              <Button size="sm" disabled={blocked} onClick={() => requestAction('create')}>
                {translate(
                  'auto.components.settings.PluginEnvironmentProviderCard.create',
                  'Create environment'
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.loading',
              'Reading saved inventory…'
            )}
          </p>
        ) : null}
        {running || pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            <p role="status" className="text-sm">
              {running
                ? translate(
                    'auto.components.settings.PluginEnvironmentProviderCard.inProgress',
                    'Provider operation in progress'
                  )
                : translate(
                    'auto.components.settings.PluginEnvironmentProviderCard.savedPending',
                    'A saved operation has no final response'
                  )}
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const operationId = running ?? pending?.operationId
                if (operationId) {
                  void window.api.plugins
                    .cancelEnvironmentProvider?.({ operationId })
                    .then((stopped) => {
                      if (!stopped) {
                        setError(
                          translate(
                            'auto.components.settings.PluginEnvironmentProviderCard.stopUnavailable',
                            'This window cannot stop that operation. Refresh inventory or check its receipt; the original change will not be retried.'
                          )
                        )
                      }
                    })
                    .catch(() =>
                      setError(
                        translate(
                          'auto.components.settings.PluginEnvironmentProviderCard.stopFailed',
                          'Could not stop the provider command. Wait for its result or check the original operation’s receipt.'
                        )
                      )
                    )
                }
              }}
            >
              {translate(
                'auto.components.settings.PluginEnvironmentProviderCard.stop',
                'Stop command'
              )}
            </Button>
          </div>
        ) : null}
        {blocked && !running && !pending ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.unresolved',
              'An earlier machine change needs reconciliation before another change. Refresh can retrieve inventory; the operation history remains saved.'
            )}
          </p>
        ) : null}
        {needsInventory ? (
          <p role="status" className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderCard.recoveredInventory',
              'The provider confirmed an earlier change, but current machine details still need refreshing. Refresh inventory before reconnecting or changing that machine.'
            )}
          </p>
        ) : null}
        {error || readError ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? readError}
          </p>
        ) : null}
        {snapshot ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentProviderCard.cached',
                'Last confirmed provider inventory'
              )}
            </p>
            {snapshot.resources.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentProviderCard.empty',
                  'No machines have been saved for this account. Refresh inventory or create an environment.'
                )}
              </p>
            ) : null}
            <PluginEnvironmentConnectionResources
              provider={provider}
              onReviewing={(operationId) => {
                operation.current = operationId
                setRunning(operationId)
              }}
              resources={snapshot.resources}
              blockedResourceIds={snapshot.operations
                .filter((entry) => isEnvironmentRecipeResourceInventoryUnconfirmed(entry))
                .flatMap((entry) => {
                  const id = environmentRecipeRecoveredResourceId(entry)
                  return id ? [id] : []
                })}
              actions={provider.actions}
              blocked={blocked}
              ready={ready}
              onAction={requestAction}
            />
          </div>
        ) : null}
      </div>
      {snapshot ? (
        <PluginEnvironmentOperationHistory
          provider={provider}
          operations={snapshot.operations}
          busy={Boolean(running)}
          onInspected={() => {
            setError(null)
            void load()
          }}
        />
      ) : null}
      {(provider.configuration.status === 'ready' ||
        provider.configuration.status === 'migration-required') &&
      window.api.plugins.prepareEnvironmentProviderMigration ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(running)}
          onClick={() => setMigrating(true)}
        >
          {translate(
            'auto.components.settings.PluginEnvironmentProviderCard.reviewConfiguration',
            'Review configuration / switch account'
          )}
        </Button>
      ) : null}
      {snapshot ? (
        <PluginEnvironmentPreviousHistory
          provider={provider}
          count={snapshot.previousBindings?.length ?? 0}
        />
      ) : null}
      {migrating ? (
        <PluginEnvironmentMigrationDialog
          provider={provider}
          onClose={() => setMigrating(false)}
          onConfigured={() => {
            setError(null)
            void load()
          }}
        />
      ) : null}
      {intent ? (
        <PluginEnvironmentActionDialog
          intent={intent}
          onClose={() => setIntent(null)}
          onRun={(parameters) => run(intent, parameters)}
          onStop={() => {
            const operationId = operation.current
            return operationId
              ? (window.api.plugins.cancelEnvironmentProvider?.({ operationId }) ??
                  Promise.resolve(false))
              : Promise.resolve(false)
          }}
        />
      ) : null}
    </article>
  )
}
