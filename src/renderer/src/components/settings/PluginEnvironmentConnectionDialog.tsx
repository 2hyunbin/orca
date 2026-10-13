import { useId, useRef, useState } from 'react'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'

export function PluginEnvironmentConnectionDialog({
  preview: current,
  onClose,
  onSave
}: {
  preview: EnvironmentProviderSshPreview
  onClose(): void
  onSave(identityFile?: string): Promise<void>
}): React.JSX.Element {
  const preview = useRef(current).current
  const connection = preview.resource.connection
  const [identityFile, setIdentityFile] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState(false)
  const id = useId()
  const save = async (): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(false)
    try {
      await onSave(identityFile.trim() || undefined)
    } catch {
      setError(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security" scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginEnvironmentConnectionDialog.title',
              'Connect to environment'
            )}
          </DialogTitle>
          <DialogDescription>
            {preview.resource.name} · {getLocalExecutionHostLabel()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.provider',
                  'Provider / account'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">
                {preview.providerId}
                <br />
                {preview.contextId}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.machine',
                  'Machine / revision'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">
                {preview.resource.id}
                <br />
                {preview.resource.revision}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.endpoint',
                  'SSH endpoint'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">
                {connection?.username}@{connection?.host}:{connection?.port}
              </dd>
            </div>
            {connection?.configHost ? (
              <div>
                <dt className="text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginEnvironmentConnectionDialog.alias',
                    'SSH configuration alias'
                  )}
                </dt>
                <dd className="break-words font-mono text-xs">{connection.configHost}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.root',
                  'Suggested project directory'
                )}
              </dt>
              <dd className="break-words font-mono text-xs">{connection?.projectRoot}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentConnectionDialog.trust',
              'These connection details come from the reviewed provider. Orca will use its normal SSH credentials and host-key checks. Saving a host does not open or move a workspace.'
            )}
          </p>
          <div className="space-y-2">
            <Label htmlFor={id}>
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionDialog.key',
                'Identity file (optional)'
              )}
            </Label>
            <Input
              id={id}
              value={identityFile}
              disabled={busy}
              onChange={(event) => setIdentityFile(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionDialog.keyHint',
                'Leave blank to use your existing SSH configuration or agent.'
              )}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionDialog.saveError',
                'Could not save this connection. Close this review and refresh the machine’s current details before trying again.'
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionDialog.cancel',
                'Cancel'
              )}
            </Button>
            <Button type="submit" disabled={busy || !connection}>
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionDialog.save',
                'Save & connect'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
