import { useEffect, useRef, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import { useAppStore } from '../store'
import { i18n, setRendererPluginLanguagePacks } from './i18n'
import { resolveUiLocale } from './supported-languages'
import { resolvePluginUiResourceLanguage } from '../../../shared/plugins/plugin-bundled-data-aliases'
import { usePluginLanguagePacks, usePluginLanguagePackStore } from '../store/plugin-language-packs'

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Why: settings arrive async over IPC; until they load we must not apply any
  // language. Falling back to 'system' here used to kick off an OS-locale
  // changeLanguage that raced with (and could permanently override) the
  // persisted preference applied moments later.
  const uiLanguage = useAppStore((state) => state.settings?.uiLanguage ?? null)
  const pluginLanguagePacks = usePluginLanguagePacks()
  const aliases = usePluginLanguagePackStore((state) => state.aliases)
  const locale =
    uiLanguage === null
      ? null
      : resolvePluginUiResourceLanguage(resolveUiLocale(uiLanguage), pluginLanguagePacks, aliases)
  const requestedLocale = useRef<string | null>(null)

  useEffect(() => {
    setRendererPluginLanguagePacks(pluginLanguagePacks, aliases)
    requestedLocale.current = null
  }, [pluginLanguagePacks, aliases])

  useEffect(() => {
    // Why: track the last *requested* locale instead of checking i18n.language —
    // an in-flight lazy catalog load leaves i18n.language stale, which made the
    // guard skip corrections back to the persisted language.
    if (locale === null || requestedLocale.current === locale) {
      return
    }
    requestedLocale.current = locale
    void i18n.changeLanguage(locale)
  }, [locale, pluginLanguagePacks, aliases])

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
