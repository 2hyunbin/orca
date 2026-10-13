import { useId, useRef, useState } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { PluginEnvironmentProviderMigrationPreview } from '../../../../shared/plugins/plugin-environment-provider-migration-api'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
import { PluginEnvironmentMigrationInventory } from './PluginEnvironmentMigrationInventory'

export function PluginEnvironmentMigrationDialog({
  provider: current,
  onClose,
  onConfigured
}: {
  provider: PluginEnvironmentProviderEntry
  onClose(): void
  onConfigured(): void
}): React.JSX.Element {
  const provider = useRef(current).current
  const [contextId, setContextId] = useState(
    'contextId' in provider.configuration ? provider.configuration.contextId : ''
  )
  const [preview, setPreview] = useState<PluginEnvironmentProviderMigrationPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<string | null>(null)
  const committing = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const prepare = async (): Promise<void> => {
    const prepare = window.api.plugins.prepareEnvironmentProviderMigration
    if (pending.current || committing.current || !prepare || !contextId.trim()) {
      return
    }
    const queryId = createBrowserUuid()
    pending.current = queryId
    setBusy(true)
    setError(null)
    try {
      setPreview(
        await prepare({ review: { ...provider.review, contextId: contextId.trim() }, queryId })
      )
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentMigrationDialog.prepareError',
          'Could not verify this account and configuration. Check the provider’s approval and sign-in, or settle any unresolved change in the original account before switching.'
        )
      )
    } finally {
      pending.current = null
      setBusy(false)
    }
  }
  const commit = async (): Promise<void> => {
    const commit = window.api.plugins.commitEnvironmentProviderMigration
    if (!preview || committing.current || pending.current || !commit) {
      return
    }
    committing.current = true
    setBusy(true)
    setError(null)
    try {
      await commit({ ticketId: preview.ticketId })
      onConfigured()
      onClose()
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentMigrationDialog.commitError',
          'The configuration changed during review. Close this dialog and check it again. Previous history remains saved.'
        )
      )
    } finally {
      committing.current = false
      setBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    const queryId = pending.current
    if (!queryId) {
      return
    }
    try {
      const stopped = await window.api.plugins.cancelEnvironmentProvider?.({ operationId: queryId })
      if (!stopped && pending.current === queryId) {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentMigrationDialog.stopUnavailable',
            'Could not stop this account check. Wait for it to finish before closing.'
          )
        )
      }
    } catch {
      if (pending.current === queryId) {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentMigrationDialog.stopFailed',
            'Could not stop this account check. Wait for it to finish before closing.'
          )
        )
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginEnvironmentMigrationDialog.title',
              'Review provider configuration'
            )}
          </DialogTitle>
          <DialogDescription>
            {provider.name} · {getLocalExecutionHostLabel()}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-4 overflow-y-auto scrollbar-sleek">
          {!preview ? (
            <>
              <p className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentMigrationDialog.checkExplanation',
                  'Check the newly reviewed provider’s List command for this account. Previous machines and operation history remain saved. This check does not create, sleep or delete machines.'
                )}
              </p>
              <div className="space-y-2">
                <Label htmlFor={id}>
                  {translate(
                    'auto.components.settings.PluginEnvironmentMigrationDialog.account',
                    'Account / tenant ID'
                  )}
                </Label>
                <Input
                  id={id}
                  value={contextId}
                  disabled={busy}
                  onChange={(event) => setContextId(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentMigrationDialog.confirmExplanation',
                  'Only the machines confirmed under this account become current. Previous configuration history is kept separately. Existing SSH connections will be retired; workspaces and machines are not deleted.'
                )}
              </p>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginEnvironmentMigrationDialog.previous',
                      'Previous account'
                    )}
                  </dt>
                  <dd className="break-words font-mono text-xs">
                    {preview.previousBinding.contextId}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginEnvironmentMigrationDialog.next',
                      'Reviewed account'
                    )}
                  </dt>
                  <dd className="break-words font-mono text-xs">{preview.nextBinding.contextId}</dd>
                </div>
              </dl>
              {preview.unresolvedOperationIds.length ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginEnvironmentMigrationDialog.unresolved',
                    'Unresolved changes in this account stay blocked. This configuration update does not confirm or repeat them.'
                  )}
                </p>
              ) : null}
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.PluginEnvironmentMigrationDialog.inventory',
                  'Machines confirmed by the provider'
                )}{' '}
                ({preview.currentResources.length})
              </p>
              <PluginEnvironmentMigrationInventory resources={preview.currentResources} />
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginEnvironmentMigrationDialog.provenance',
                    'Configuration fingerprints'
                  )}
                </summary>
                <p className="break-words font-mono text-xs text-muted-foreground">
                  {preview.previousBinding.sourceDigest}
                  <br />
                  {preview.nextBinding.sourceDigest}
                </p>
              </details>
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentMigrationDialog.working',
                'Checking or saving configuration…'
              )}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {pending.current ? (
            <Button variant="ghost" onClick={() => void stop()}>
              {translate(
                'auto.components.settings.PluginEnvironmentMigrationDialog.stop',
                'Stop check'
              )}
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {translate(
                'auto.components.settings.PluginEnvironmentMigrationDialog.cancel',
                'Cancel'
              )}
            </Button>
          )}
          {preview ? (
            <Button disabled={busy} onClick={() => void commit()}>
              {translate(
                'auto.components.settings.PluginEnvironmentMigrationDialog.confirm',
                'Confirm configuration'
              )}
            </Button>
          ) : (
            <Button disabled={busy || !contextId.trim()} onClick={() => void prepare()}>
              {translate(
                'auto.components.settings.PluginEnvironmentMigrationDialog.check',
                'Check account'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
