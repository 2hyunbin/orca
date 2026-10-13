import { useState } from 'react'
import { Languages, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/plugin-language-pack-artifact'

export function PluginLanguageAction({
  pluginKey,
  disabled = false
}: {
  pluginKey: string
  disabled?: boolean
}): React.JSX.Element | null {
  const packs = usePluginLanguagePackStore((state) => state.packs).filter(
    (pack) => pack.pluginKey === pluginKey
  )
  const selected = useAppStore((state) => state.settings?.uiLanguage)
  const [busy, setBusy] = useState(false)
  if (!packs.length) {
    return null
  }
  if (packs.some((pack) => pack.id === selected || pack.builtInLocale === selected)) {
    return (
      <Badge variant="secondary">
        {translate('auto.components.settings.PluginLanguageAction.selected', 'Using language')}
      </Badge>
    )
  }
  const applyLanguage = async (pack: PluginLanguagePackRegistration): Promise<void> => {
    if (busy || disabled) {
      return
    }
    setBusy(true)
    try {
      await useAppStore
        .getState()
        .updateSettingsOrThrow({ uiLanguage: pack.builtInLocale ?? pack.id })
    } catch {
      toast.error(
        translate(
          'auto.components.settings.PluginLanguageAction.failed',
          'Could not change the language. Try again.'
        )
      )
    } finally {
      setBusy(false)
    }
  }
  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || disabled}
      onClick={packs.length === 1 ? () => void applyLanguage(packs[0]!) : undefined}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Languages />}
      {translate('auto.components.settings.PluginLanguageAction.use', 'Use language')}
    </Button>
  )
  if (packs.length === 1) {
    return button
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {packs.map((pack) => (
          <DropdownMenuItem key={pack.id} onSelect={() => void applyLanguage(pack)}>
            {pack.displayName ?? pack.locale}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
