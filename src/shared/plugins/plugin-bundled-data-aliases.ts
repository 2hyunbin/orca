import { z } from 'zod'
import type { PluginLanguagePackRegistration } from './plugin-language-pack-artifact'

export const BUNDLED_SPANISH_PLUGIN_KEY = 'stablyai.orca-locale-es'
export const BUNDLED_TYPST_PLUGIN_KEY = 'stablyai.orca-syntax-typst'

export const pluginBundledDataAliasesSchema = z.strictObject({
  locales: z.array(z.literal('es')).max(1),
  languages: z.array(z.literal('typst')).max(1)
})
export type PluginBundledDataAliases = z.infer<typeof pluginBundledDataAliasesSchema>
export const NO_BUNDLED_DATA_ALIASES: PluginBundledDataAliases = { locales: [], languages: [] }

export function resolvePluginUiResourceLanguage(
  locale: string,
  packs: readonly PluginLanguagePackRegistration[],
  aliases: PluginBundledDataAliases
): string {
  return (
    packs.find((pack) => pack.id === locale || pack.builtInLocale === locale)?.resourceLanguage ??
    (locale.startsWith('plugin:') || aliases.locales.some((alias) => alias === locale)
      ? 'en'
      : locale)
  )
}
