import type { i18n } from 'i18next'
import type { PluginLanguagePackRegistration } from './plugin-language-pack-artifact'

export const SPANISH_SECURITY_RESOURCE = 'orcaesprotected'

type PluralRuleResolver = {
  getRule: (code: string, options?: { ordinal?: boolean }) => Intl.PluralRules
}

function isPluralRuleResolver(value: unknown): value is PluralRuleResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getRule' in value &&
    typeof value.getRule === 'function'
  )
}

export function installPluginLanguagePluralRules(
  instance: i18n,
  packs: () => readonly PluginLanguagePackRegistration[]
): void {
  const resolver: unknown = instance.services.pluralResolver
  if (!isPluralRuleResolver(resolver)) {
    throw new Error('Unsupported i18next plural resolver')
  }
  const getRule = resolver.getRule.bind(resolver)
  // Synthetic resource identities must use the declared locale's CLDR rules.
  resolver.getRule = (code, options) =>
    getRule(
      code === SPANISH_SECURITY_RESOURCE
        ? 'es'
        : (packs().find((pack) => pack.resourceLanguage === code)?.locale ?? code),
      options
    )
}

export function pluginLanguageFallbacks(
  code: string | undefined,
  packs: readonly PluginLanguagePackRegistration[]
): string[] {
  return code !== SPANISH_SECURITY_RESOURCE &&
    packs.some((pack) => pack.resourceLanguage === code && pack.builtInLocale === 'es')
    ? [SPANISH_SECURITY_RESOURCE, 'en']
    : ['en']
}
