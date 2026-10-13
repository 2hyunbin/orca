import { useEffect, useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore, usePluginFileViewerRegistry } from '@/store/plugin-file-viewers'
import type { OpenFile } from '@/store/slices/editor'
import { matchingPluginFileViewers } from '@/lib/plugin-file-opening-plan'
import { translate } from '@/i18n/i18n'
import {
  defaultPluginViewerSelector,
  selectedPluginViewerAssociation
} from '../../../../shared/plugins/plugin-viewer-associations'
import { openPluginFileChoice } from './open-plugin-file-choice'
import { updatePluginViewerAssociation } from '@/store/update-plugin-viewer-association'

export function PluginFileViewerPicker({
  file,
  viewStateId,
  onOpenChange
}: {
  file: OpenFile
  viewStateId?: string
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element | null {
  usePluginFileViewerRegistry()
  const registry = usePluginFileViewerStore(
    useShallow((state) => ({
      status: state.status,
      viewers: state.viewers,
      syntaxPacks: state.syntaxPacks
    }))
  )
  const associations = useAppStore((state) => state.settings?.pluginViewerAssociations)
  const matching = matchingPluginFileViewers(registry, file.filePath)
  const association = selectedPluginViewerAssociation(associations ?? [], file.filePath)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const active =
    file.mode === 'plugin-viewer'
      ? file.pluginViewer?.key
      : file.mode === 'edit'
        ? 'core'
        : undefined
  const [selected, setSelected] = useState(active ?? '')
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const checkboxId = useId()
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const viewer = matching.find((item) => item.key === selected)
  const selector = defaultPluginViewerSelector(file.filePath, viewer)
  const search = query.trim().toLowerCase()
  const filtered = matching
    .filter((item) =>
      `${item.displayName} ${item.pluginName} ${item.pluginKey}`.toLowerCase().includes(search)
    )
    .slice(0, 50)
  if (
    !matching.length &&
    !association &&
    file.mode !== 'plugin-viewer' &&
    file.mode !== 'file-opening'
  ) {
    return null
  }
  const choose = async (): Promise<void> => {
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      await openPluginFileChoice(
        file,
        selected,
        always ? selector : undefined,
        viewStateId,
        controller.signal
      )
      setOpen(false)
      onOpenChange?.(false)
    } catch {
      if (!controller.signal.aborted) {
        toast.error(
          translate(
            'plugins.viewer.choiceFailed',
            'Could not open this viewer. Check its availability and reopen the file after its connection settles.'
          )
        )
      }
    } finally {
      setBusy(false)
    }
  }
  const reset = async (): Promise<void> => {
    if (!association) {
      return
    }
    setBusy(true)
    try {
      await updatePluginViewerAssociation(association.selector, 'auto')
    } catch {
      toast.error(
        translate(
          'plugins.viewer.defaultSaveFailed',
          'Could not save the viewer default. Try again.'
        )
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          pending.current?.abort()
        }
        setOpen(next)
        onOpenChange?.(next)
        if (next) {
          setSelected(active ?? '')
          setAlways(false)
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" disabled={busy}>
          {translate('plugins.viewer.openWith', 'Open with')}
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={translate('plugins.viewer.search', 'Search viewers…')}
            aria-label={translate('plugins.viewer.search', 'Search viewers…')}
          />
          <CommandList>
            <CommandEmpty>
              {translate('plugins.viewer.noMatching', 'No matching viewers')}
            </CommandEmpty>
            {!search && !file.pluginViewerUserSelectedFile && (
              <CommandItem value="core" onSelect={() => setSelected('core')}>
                <div className="min-w-0 flex-1">
                  <p>{translate('plugins.viewer.orca', 'Orca viewer')}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      active === 'core' ? translate('plugins.viewer.current', 'Current') : null,
                      association?.viewerKey === 'core'
                        ? translate('plugins.viewer.savedDefault', 'Default')
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {selected === 'core' && <Check className="size-3" />}
              </CommandItem>
            )}
            {filtered.map((item) => (
              <CommandItem key={item.key} value={item.key} onSelect={() => setSelected(item.key)}>
                <div className="min-w-0 flex-1">
                  <p className="truncate">{item.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.pluginName} · {item.pluginKey}
                  </p>
                  {(active === item.key || association?.viewerKey === item.key) && (
                    <p className="text-xs text-muted-foreground">
                      {[
                        active === item.key ? translate('plugins.viewer.current', 'Current') : null,
                        association?.viewerKey === item.key
                          ? translate('plugins.viewer.savedDefault', 'Default')
                          : null
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                {selected === item.key && <Check className="size-3" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <div className="space-y-3 border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || registry.status === 'unsupported'}
            onClick={() => {
              setOpen(false)
              onOpenChange?.(false)
              useAppStore.getState().openPluginFileViewerCatalog()
            }}
          >
            {translate('plugins.viewer.browse', 'Browse file viewers')}
          </Button>
          {selector && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={always}
                disabled={busy}
                onCheckedChange={(value) => setAlways(value === true)}
              />
              <Label htmlFor={checkboxId}>
                {selector.kind === 'extension'
                  ? translate(
                      'plugins.viewer.alwaysExtension',
                      'Always use for {{extension}} files',
                      { extension: selector.value }
                    )
                  : translate(
                      'plugins.viewer.alwaysFilename',
                      'Always use for files named {{filename}}',
                      { filename: selector.value }
                    )}
              </Label>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {association ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>
                {translate('plugins.viewer.resetDefault', 'Reset default')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              size="sm"
              disabled={
                busy ||
                (selected !== 'core' && !viewer) ||
                (selected === 'core' && file.pluginViewerUserSelectedFile === true)
              }
              onClick={() => void choose()}
            >
              {always
                ? translate('plugins.viewer.setDefaultAndOpen', 'Set default and open')
                : translate('plugins.viewer.openOnce', 'Open once')}
            </Button>
          </div>
          {matching.length > 50 && !search && (
            <p className="text-xs text-muted-foreground">
              {translate('plugins.viewer.searchMore', 'Search to find more installed viewers.')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
