import { usePluginEnvironmentHostLabel } from './plugin-environment-host-context'
import { useId, useRef, useState } from 'react'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
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
  const hostLabel = usePluginEnvironmentHostLabel()
  const preview = useRef(current).current
  const connection = preview.resource.connection
  const previous = preview.endpointUpdate?.previousConnection
  const cancel = useRef<HTMLButtonElement>(null)
  const [identityFile, setIdentityFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const mounted = useMountedRef()
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
    const timer = setTimeout(() => {
      if (mounted.current) {
        setSlow(true)
      }
    }, 1000)
    try {
      await onSave(identityFile.trim() || undefined)
    } catch {
      if (mounted.current) {
        setError(true)
      }
    } finally {
      busyRef.current = false
      clearTimeout(timer)
      if (mounted.current) {
        setBusy(false)
        setSlow(false)
      }
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
      <DialogContent
        surface="security"
        className="max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        onOpenAutoFocus={(event) => {
          if (previous) {
            event.preventDefault()
            cancel.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {previous
              ? translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.updateTitle',
                  'Update saved environment connection'
                )
              : translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.title',
                  'Connect to environment'
                )}
          </DialogTitle>
          <DialogDescription>
            {preview.resource.name} · {hostLabel}
            {previous ? (
              <span className="mt-2 block">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.updateSummary',
                  'Updating will close the old connection. This host keeps its workspaces, history and managed server.'
                )}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div
            role="region"
            aria-label={translate(
              'auto.components.settings.PluginEnvironmentConnectionDialog.details',
              'Connection details'
            )}
            className="scrollbar-sleek min-h-0 space-y-4 overflow-y-auto"
          >
            <dl className="space-y-2 text-sm">
              {previous ? (
                <div>
                  <dt className="text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginEnvironmentConnectionDialog.previousEndpoint',
                      'Previously saved SSH endpoint'
                    )}
                  </dt>
                  <dd className="break-words font-mono text-xs">
                    {previous.username}@{previous.host}:{previous.port}
                  </dd>
                  {previous.configHost ? (
                    <dd className="break-words font-mono text-xs">{previous.configHost}</dd>
                  ) : null}
                  <dd className="break-words font-mono text-xs">{previous.projectRoot}</dd>
                </div>
              ) : null}
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
                  {previous
                    ? translate(
                        'auto.components.settings.PluginEnvironmentConnectionDialog.newEndpoint',
                        'New SSH endpoint'
                      )
                    : translate(
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
            {previous ? (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.updateExplanation',
                  'Automations bound to the old connection need a new review. Orca will check SSH credentials and host trust before reconnecting.'
                )}
              </p>
            ) : null}
            {!previous ? (
              <p className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.trust',
                  'These connection details come from the reviewed provider. Orca will use its normal SSH credentials and host-key checks. Saving a host does not open or move a workspace.'
                )}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={id}>
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.key',
                  'Identity file (optional)'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.credentialHost',
                  'SSH configuration, identity files and the agent belong to {{host}}.',
                  { host: hostLabel }
                )}
              </p>
              <Input
                id={id}
                value={identityFile}
                disabled={busy}
                onChange={(event) => setIdentityFile(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {preview.endpointUpdate?.savedIdentityFile
                  ? translate(
                      'auto.components.settings.PluginEnvironmentConnectionDialog.keepSavedKey',
                      'Leave blank to keep this host’s saved identity file.'
                    )
                  : translate(
                      'auto.components.settings.PluginEnvironmentConnectionDialog.keyHint',
                      'Leave blank to use your existing SSH configuration or agent.'
                    )}
              </p>
            </div>
          </div>
          <div className="space-y-3">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.saveError',
                  'Could not save this connection. Close this review and refresh the machine’s current details before trying again.'
                )}
              </p>
            ) : null}
            <p role="status" className="min-h-4 text-xs text-muted-foreground">
              {slow
                ? translate(
                    'auto.components.settings.PluginEnvironmentConnectionDialog.saving',
                    'Saving connection…'
                  )
                : null}
            </p>
            <DialogFooter>
              <Button ref={cancel} type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {translate(
                  'auto.components.settings.PluginEnvironmentConnectionDialog.cancel',
                  'Cancel'
                )}
              </Button>
              <Button type="submit" disabled={busy || !connection}>
                {previous
                  ? translate(
                      'auto.components.settings.PluginEnvironmentConnectionDialog.updateSave',
                      'Update & connect'
                    )
                  : translate(
                      'auto.components.settings.PluginEnvironmentConnectionDialog.save',
                      'Save & connect'
                    )}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
