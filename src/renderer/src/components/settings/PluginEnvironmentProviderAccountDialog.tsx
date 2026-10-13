import { useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import { translate } from '@/i18n/i18n'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
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

export function PluginEnvironmentProviderAccountDialog({
  provider: current,
  onConfigured,
  onClose
}: {
  provider: PluginEnvironmentProviderEntry
  onConfigured(providers: PluginEnvironmentProviderEntry[]): void
  onClose(): void
}): React.JSX.Element {
  const provider = useRef(current).current
  const [contextId, setContextId] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const save = async (): Promise<void> => {
    const configure = window.api.plugins.configureEnvironmentProvider
    if (busyRef.current || !contextId.trim() || !configure) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await configure({ ...provider.review, contextId: contextId.trim() })
      onConfigured(result)
      onClose()
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentProviderAccountDialog.saveError',
          'Could not save this account. Refresh the provider and review its current source and commands before trying again.'
        )
      )
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
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginEnvironmentProviderAccountDialog.title',
              'Set up provider account'
            )}
          </DialogTitle>
          <DialogDescription>
            {provider.name} · {getLocalExecutionHostLabel()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={id}>
              {translate(
                'auto.components.settings.PluginEnvironmentProviderAccountDialog.account',
                'Account / tenant ID'
              )}
            </Label>
            <Input
              id={id}
              value={contextId}
              onChange={(event) => setContextId(event.target.value)}
              maxLength={256}
              disabled={busy}
              required
              autoFocus
              aria-describedby={`${id}-help`}
            />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentProviderAccountDialog.help',
                'Use the account, tenant and region identifier accepted by your company’s provider. Do not enter a token or password.'
              )}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.PluginEnvironmentProviderAccountDialog.binding',
              'Orca keeps machines and operation history attached to this account and this provider’s reviewed source. Saving an account does not run provider commands.'
            )}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {translate(
                'auto.components.settings.PluginEnvironmentProviderAccountDialog.cancel',
                'Cancel'
              )}
            </Button>
            <Button type="submit" disabled={busy || !contextId.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {translate(
                'auto.components.settings.PluginEnvironmentProviderAccountDialog.save',
                'Save account'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
