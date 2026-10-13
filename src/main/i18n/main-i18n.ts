import { app } from 'electron'
import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'

import { isPseudoLocalizationLocale, pseudoLocalizeString } from '../../shared/pseudo-localization'
import { DEFAULT_UI_LOCALE, resolveUiLocale, type SupportedUiLocale } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'
import type { PluginLanguagePackRegistration } from '../../shared/plugins/plugin-language-pack-artifact'
import {
  NO_BUNDLED_DATA_ALIASES,
  resolvePluginUiResourceLanguage,
  type PluginBundledDataAliases
} from '../../shared/plugins/plugin-bundled-data-aliases'
import {
  SPANISH_SECURITY_RESOURCE,
  installPluginLanguagePluralRules,
  pluginLanguageFallbacks
} from '../../shared/plugins/plugin-language-i18next'

export const mainI18n: I18nInstance = i18next.createInstance()

let initialized = false
let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []
let bundledDataAliases = NO_BUNDLED_DATA_ALIASES
const registeredPluginLanguages = new Set<string>()

// Why: main-process callers pass English fallbacks to translateMain(), so the
// main bundle does not need to parse any locale catalog at cold start. Only
// non-English users pay for their selected catalog, after i18n is awaited.
const LAZY_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('../../renderer/src/i18n/locales/es.json'),
  fr: () => import('../../renderer/src/i18n/locales/fr.json'),
  ja: () => import('../../renderer/src/i18n/locales/ja.json'),
  ko: () => import('../../renderer/src/i18n/locales/ko.json'),
  zh: () => import('../../renderer/src/i18n/locales/zh.json')
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    if (language === SPANISH_SECURITY_RESOURCE) {
      import('../../renderer/src/i18n/locales/es-plugin-security.json').then(
        (mod) => callback(null, mod.default),
        (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
      )
      return
    }
    const loader = LAZY_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English is intentionally represented by the empty bundled resource; its
      // user-visible copy comes from translateMain() defaultValue fallbacks.
      callback(null, false)
      return
    }
    loader().then(
      (mod) => callback(null, mod.default),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

export function getMainSystemLocale(): string {
  try {
    return app.getLocale()
  } catch {
    return DEFAULT_UI_LOCALE
  }
}

export async function ensureMainI18n(): Promise<I18nInstance> {
  if (!initialized) {
    await mainI18n.use(lazyLocaleBackend).init({
      fallbackLng: (code) => pluginLanguageFallbacks(code, pluginLanguagePacks),
      lng: DEFAULT_UI_LOCALE,
      // Why: mark the default locale loaded with an empty resource bundle. Main
      // process English strings come from translateMain() fallbacks, and
      // partialBundledLanguages lets the backend supply non-English catalogs.
      partialBundledLanguages: true,
      resources: {
        en: {
          translation: {}
        }
      },
      interpolation: {
        escapeValue: false
      }
    })
    initialized = true
    installPluginLanguagePluralRules(mainI18n, () => pluginLanguagePacks)
    applyMainPluginLanguagePacks()
  }
  return mainI18n
}

export async function setMainUiLanguage(language: UiLanguage): Promise<string> {
  await ensureMainI18n()
  const selectedLocale = resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getMainSystemLocale() : DEFAULT_UI_LOCALE
  )
  const locale = resolvePluginUiResourceLanguage(
    selectedLocale,
    pluginLanguagePacks,
    bundledDataAliases
  )
  if (mainI18n.language !== locale) {
    // changeLanguage triggers the lazy backend load for non-English locales and
    // resolves once the catalog is in memory, so callers that await this have
    // the translations ready before they render menus/dialogs.
    await mainI18n.changeLanguage(locale)
  }
  return locale
}

function applyMainPluginLanguagePacks(): void {
  for (const language of registeredPluginLanguages) {
    mainI18n.removeResourceBundle(language, 'translation')
  }
  registeredPluginLanguages.clear()
  for (const pack of pluginLanguagePacks) {
    mainI18n.addResourceBundle(pack.resourceLanguage, 'translation', pack.catalog, true, true)
    registeredPluginLanguages.add(pack.resourceLanguage)
  }
}

export function setMainPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[],
  aliases: PluginBundledDataAliases = NO_BUNDLED_DATA_ALIASES
): boolean {
  if (pluginLanguagePacks === packs && bundledDataAliases === aliases) {
    return false
  }
  pluginLanguagePacks = packs
  bundledDataAliases = aliases
  if (initialized) {
    applyMainPluginLanguagePacks()
  }
  return true
}

export function translateMain(key: string, fallback: string, options?: TOptions): string {
  // Why: menu registration can run before async init finishes in tests; fall back
  // to the English default instead of returning undefined from an uninitialized i18n.
  const raw = initialized ? mainI18n.t(key, { defaultValue: fallback, ...options }) : fallback
  const value = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  return isPseudoLocalizationLocale(mainI18n.language) ? pseudoLocalizeString(value) : value
}
