import { createPluginLocaleKit, type PluginLocaleKit } from '../../shared/plugins/plugin-locale-kit'

let currentKit: Promise<PluginLocaleKit> | undefined

export function getPluginLocaleKit(): Promise<PluginLocaleKit> {
  // Only locale-pack validation pays for the English source catalog.
  currentKit ??= import('../../renderer/src/i18n/locales/en.json').then(({ default: english }) =>
    createPluginLocaleKit(english)
  )
  return currentKit
}
