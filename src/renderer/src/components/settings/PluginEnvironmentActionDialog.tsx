import { usePluginEnvironmentHostLabel } from './plugin-environment-host-context'
import { useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type {
  EnvironmentRecipeAction,
  EnvironmentRecipeResource
} from '../../../../shared/environment-recipe-protocol'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '../ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'

export type PluginEnvironmentActionIntent = {
  provider: PluginEnvironmentProviderEntry
  action: EnvironmentRecipeAction
  resource?: EnvironmentRecipeResource
}
export function PluginEnvironmentActionDialog({
  intent: current,
  onClose,
  onRun,
  onStop
}: {
  intent: PluginEnvironmentActionIntent
  onClose(): void
  onRun(parameters: Record<string, string>): Promise<void>
  onStop(): Promise<boolean>
}): React.JSX.Element {
  const hostLabel = usePluginEnvironmentHostLabel()
  const intent = useRef(current).current
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const destructive = intent.action === 'delete' || intent.action === 'archive'
  const fields = intent.action === 'create' ? intent.provider.createFields : []
  const title =
    intent.action === 'create'
      ? translate(
          'auto.components.settings.PluginEnvironmentActionDialog.create',
          'Create environment'
        )
      : intent.action === 'sleep'
        ? translate(
            'auto.components.settings.PluginEnvironmentActionDialog.sleep',
            'Sleep environment'
          )
        : intent.action === 'resume'
          ? translate(
              'auto.components.settings.PluginEnvironmentActionDialog.wake',
              'Wake environment'
            )
          : intent.action === 'archive'
            ? translate(
                'auto.components.settings.PluginEnvironmentActionDialog.archive',
                'Archive environment'
              )
            : translate(
                'auto.components.settings.PluginEnvironmentActionDialog.delete',
                'Delete environment'
              )
  const run = async (): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onRun(values)
    } catch {
      setError(
        translate(
          'auto.components.settings.PluginEnvironmentActionDialog.failed',
          'The provider could not confirm the change. Review the operation history and refreshed inventory before retrying.'
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
      <DialogContent
        surface="security"
        className="max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
        onOpenAutoFocus={(event) => {
          if (destructive) {
            event.preventDefault()
            cancelRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {intent.provider.name} · {hostLabel}
            {intent.resource ? ` · ${intent.resource.name}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void run()
          }}
        >
          <div className="scrollbar-sleek min-h-0 space-y-4 overflow-y-auto">
            {'contextId' in intent.provider.configuration ? (
              <p className="break-words text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginEnvironmentActionDialog.account',
                  'Account: {{account}}',
                  { account: intent.provider.configuration.contextId }
                )}
              </p>
            ) : null}
            {intent.resource ? (
              <p className="break-words font-mono text-xs text-muted-foreground">
                {intent.resource.id} · {intent.resource.revision}
              </p>
            ) : null}
            {intent.action === 'delete' ? (
              <p className="text-sm">
                {translate(
                  'auto.components.settings.PluginEnvironmentActionDialog.deleteWarning',
                  'This runs the provider’s Delete command for the selected machine. The machine and its data may be permanently removed.'
                )}
              </p>
            ) : null}
            {intent.action === 'archive' ? (
              <p className="text-sm">
                {translate(
                  'auto.components.settings.PluginEnvironmentActionDialog.archiveWarning',
                  'This runs the provider’s Archive command for the selected machine. Your provider determines data retention, billing and whether it can be restored.'
                )}
              </p>
            ) : null}
            {fields.map((field) => (
              <div key={field.id} className="space-y-2">
                <Label htmlFor={`${id}-${field.id}`}>
                  {field.label}
                  {field.required ? ' *' : ''}
                </Label>
                {field.choices ? (
                  <Select
                    value={values[field.id] ?? ''}
                    onValueChange={(value) => setValues({ ...values, [field.id]: value })}
                    disabled={busy}
                  >
                    <SelectTrigger id={`${id}-${field.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.choices.map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {choice}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`${id}-${field.id}`}
                    value={values[field.id] ?? ''}
                    onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
                    maxLength={2048}
                    required={field.required}
                    disabled={busy}
                  />
                )}
                {field.description ? (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
              </div>
            ))}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            {busy ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void onStop()
                    .catch(() => false)
                    .then((stopped) => {
                      if (!stopped) {
                        setError(
                          translate(
                            'auto.components.settings.PluginEnvironmentActionDialog.stopUnavailable',
                            'This operation is no longer attached to this window. Refresh its status before starting another change.'
                          )
                        )
                      }
                    })
                }
              >
                {translate(
                  'auto.components.settings.PluginEnvironmentActionDialog.stop',
                  'Stop command'
                )}
              </Button>
            ) : null}
            <Button ref={cancelRef} type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {translate('auto.components.settings.PluginEnvironmentActionDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              variant={intent.action === 'delete' ? 'destructive' : 'default'}
              disabled={busy || fields.some((field) => field.required && !values[field.id]?.trim())}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
