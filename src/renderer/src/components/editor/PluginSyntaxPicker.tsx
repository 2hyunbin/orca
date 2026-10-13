import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { usePluginSyntaxAssociation, usePluginSyntaxStore } from '@/store/plugin-syntax-packs'
import {
  defaultPluginSyntaxSelector,
  setPluginSyntaxAssociation
} from '../../../../shared/plugins/plugin-syntax-associations'
import {
  matchingPluginSyntaxLanguages,
  resolvePluginSyntaxLanguage
} from '@/lib/monaco-languages/plugin-syntax-slot-pool'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'

export function PluginSyntaxPicker({
  filePath,
  coreLanguage
}: {
  filePath: string
  coreLanguage: string
}): React.JSX.Element | null {
  const packs = usePluginSyntaxStore((state) => state.packs)
  const available = usePluginSyntaxStore((state) => state.available)
  const association = usePluginSyntaxAssociation(filePath)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const explicit = association?.languageKey ?? 'auto'
  const effective = resolvePluginSyntaxLanguage(
    packs,
    filePath,
    coreLanguage,
    association?.languageKey
  )
  const languages = packs.flatMap((pack) =>
    pack.languages.map((language) => ({
      ...language,
      publisher: pack.pluginKey.split('.')[0] ?? '',
      packageName: pack.name
    }))
  )
  const language = languages.find((item) => item.key === effective)
  const selector =
    association?.selector ??
    defaultPluginSyntaxSelector(
      filePath,
      languages.flatMap((item) => item.extensions)
    )
  const automatic = translate('auto.components.editor.PluginSyntaxPicker.automatic', 'Automatic')
  const plain = translate('auto.components.editor.PluginSyntaxPicker.plain', 'Plain text')
  const missing = explicit.startsWith('syntax:') && !languages.some((item) => item.key === explicit)
  const conflict =
    !association &&
    coreLanguage === 'plaintext' &&
    matchingPluginSyntaxLanguages(packs, filePath).length > 1
  const label = missing
    ? translate('auto.components.editor.PluginSyntaxPicker.unavailable', 'Syntax unavailable')
    : conflict
      ? translate('auto.components.editor.PluginSyntaxPicker.choose', 'Choose syntax')
      : explicit === 'plaintext'
        ? plain
        : (language?.aliases[0] ?? automatic)
  const search = query.trim().toLowerCase()
  const filtered = languages
    .filter((item) =>
      `${item.aliases.join(' ')} ${item.id} ${item.publisher} ${item.packageName}`
        .toLowerCase()
        .includes(search)
    )
    .slice(0, 50)
  if ((!available || packs.length === 0) && !association) {
    return null
  }

  const choose = async (languageKey: string): Promise<void> => {
    setOpen(false)
    setBusy(true)
    try {
      const state = useAppStore.getState()
      await state.updateSettingsOrThrow({
        pluginSyntaxAssociations: setPluginSyntaxAssociation(
          state.settings?.pluginSyntaxAssociations ?? [],
          selector,
          languageKey
        )
      })
    } catch {
      toast.error(
        translate(
          'auto.components.editor.PluginSyntaxPicker.saveError',
          'Could not save syntax choice. Try again.'
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
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          role="combobox"
          aria-expanded={open}
          disabled={busy || !available}
          aria-label={translate(
            'auto.components.editor.PluginSyntaxPicker.choose',
            'Choose syntax'
          )}
        >
          <span className="max-w-36 truncate">{label}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'auto.components.editor.PluginSyntaxPicker.search',
              'Search syntax or publisher…'
            )}
            aria-label={translate(
              'auto.components.editor.PluginSyntaxPicker.searchLabel',
              'Search syntax'
            )}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.editor.PluginSyntaxPicker.empty',
                'No matching syntax packs'
              )}
            </CommandEmpty>
            {!search && (
              <>
                <CommandItem value="auto" onSelect={() => void choose('auto')}>
                  {automatic}
                  {explicit === 'auto' && <Check className="ml-auto size-3" />}
                </CommandItem>
                <CommandItem value="plaintext" onSelect={() => void choose('plaintext')}>
                  {plain}
                  {explicit === 'plaintext' && <Check className="ml-auto size-3" />}
                </CommandItem>
              </>
            )}
            {filtered.map((item) => (
              <CommandItem key={item.key} value={item.key} onSelect={() => void choose(item.key)}>
                <div className="min-w-0">
                  <p className="truncate">{item.aliases[0] ?? item.id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.publisher} · {item.packageName}
                  </p>
                </div>
                {explicit === item.key && <Check className="ml-auto size-3" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          <p>
            {selector.kind === 'extension'
              ? translate(
                  'auto.components.editor.PluginSyntaxPicker.extensionScope',
                  'Applies to {{extension}} files.',
                  { extension: selector.value }
                )
              : translate(
                  'auto.components.editor.PluginSyntaxPicker.filenameScope',
                  'Applies to files named {{filename}}.',
                  { filename: selector.value }
                )}
          </p>
          {missing && (
            <div>
              <p className="break-all">{explicit.slice(7)}</p>
              <p>
                {translate(
                  'auto.components.editor.PluginSyntaxPicker.missing',
                  'The selected pack is disabled or unavailable. Choose Automatic to restore the default.'
                )}
              </p>
            </div>
          )}
          {conflict && (
            <p>
              {translate(
                'auto.components.editor.PluginSyntaxPicker.conflict',
                'Several installed packs match this file. Choose the syntax to use.'
              )}
            </p>
          )}
          {languages.length > 50 && !search && (
            <p>
              {translate(
                'auto.components.editor.PluginSyntaxPicker.searchMore',
                'Search to find more installed languages.'
              )}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
