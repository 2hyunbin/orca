import { usePluginEnvironmentHost } from './plugin-environment-host-context'
import { environmentOperationActionLabel } from './plugin-environment-operation-copy'
import { useRef, useState } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeJournalOperation } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { isEnvironmentRecipeOperationUnresolved } from '../../../../shared/plugins/plugin-environment-recipe-journal'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'

export type PluginEnvironmentRecoveryIntent = {
  provider: PluginEnvironmentProviderEntry
  operation: EnvironmentRecipeJournalOperation
}
export function PluginEnvironmentRecoveryDialog({
  intent: current,
  onClose,
  onInspected
}: {
  intent: PluginEnvironmentRecoveryIntent
  onClose(): void
  onInspected(): void
}): React.JSX.Element {
  const { api: providerApi, hostLabel } = usePluginEnvironmentHost()
  const intent = useRef(current).current
  const [busy, setBusy] = useState(false)
  const query = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const check = async (): Promise<void> => {
    const configuration = intent.provider.configuration
    const inspect = providerApi.recoverEnvironmentProvider
    if (query.current || !inspect || configuration.status !== 'ready') {
      return
    }
    const queryId = createBrowserUuid()
    query.current = queryId
    setBusy(true)
    setError(null)
    try {
      const result = await inspect({
        queryId,
        originalOperationId: intent.operation.operationId,
        review: { ...intent.provider.review, contextId: configuration.contextId }
      })
      if (!isEnvironmentRecipeOperationUnresolved(result.operation)) {
        onInspected()
        onClose()
      } else {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentRecoveryDialog.unresolved',
            'The provider has not confirmed a terminal outcome. Orca keeps the original operation unresolved. Check your provider’s status or sign-in before checking again.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentRecoveryDialog.failed',
          'Could not verify the provider’s receipt. The original operation stays unresolved; refresh this provider’s approval or sign-in before checking again.'
        )
      )
    } finally {
      query.current = null
      setBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    const operationId = query.current
    if (!operationId) {
      return
    }
    try {
      const stopped = await providerApi.cancelEnvironmentProvider?.({ operationId })
      if (!stopped) {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentRecoveryDialog.stopUnavailable',
            'This window could not stop the check. Wait for its result; the original machine operation is not retried.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentRecoveryDialog.stopFailed',
          'The check could not be stopped. Wait for the provider result.'
        )
      )
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !query.current) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security" scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginEnvironmentRecoveryDialog.title',
              'Check interrupted operation'
            )}
          </DialogTitle>
          <DialogDescription>
            {intent.provider.name} · {hostLabel}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentRecoveryDialog.explanation',
              'Ask your provider for the original operation’s stored receipt. This does not rerun the machine change. An unknown or still-running outcome remains unresolved.'
            )}
          </p>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentRecoveryDialog.account',
                  'Provider / account'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">
                {intent.provider.providerId}
                <br />
                {'contextId' in intent.provider.configuration
                  ? intent.provider.configuration.contextId
                  : ''}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentRecoveryDialog.operation',
                  'Original operation'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">
                {environmentOperationActionLabel(intent.operation.action)}
                <br />
                {intent.operation.operationId}
              </dd>
            </div>
            {intent.operation.resourceId ? (
              <div>
                <dt className="text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginEnvironmentRecoveryDialog.machine',
                    'Machine / expected revision'
                  )}
                </dt>
                <dd className="break-words font-mono text-xs">
                  {intent.operation.resourceId}
                  <br />
                  {intent.operation.expectedRevision}
                </dd>
              </div>
            ) : null}
          </dl>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentRecoveryDialog.checking',
                'Checking the provider receipt…'
              )}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {busy ? (
            <Button variant="ghost" onClick={() => void stop()}>
              {translate(
                'auto.components.settings.PluginEnvironmentRecoveryDialog.stop',
                'Stop check'
              )}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {translate(
                'auto.components.settings.PluginEnvironmentRecoveryDialog.cancel',
                'Cancel'
              )}
            </Button>
          )}
          <Button disabled={busy} onClick={() => void check()}>
            {translate(
              'auto.components.settings.PluginEnvironmentRecoveryDialog.check',
              'Check with provider'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
