// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginLanguageAction } from './PluginLanguageAction'
import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/plugin-language-pack-artifact'
const localUpdate = vi.hoisted(() => vi.fn())
const remoteUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(select: (source: { settings: { uiLanguage: string } }) => T) =>
      select({ settings: { uiLanguage: 'en' } }),
    { getState: () => ({ updateSettingsOrThrow: localUpdate }) }
  )
}))
const localPack: PluginLanguagePackRegistration = {
  id: 'plugin:company.languages/es',
  resourceLanguage: 'plugines',
  pluginKey: 'company.languages',
  locale: 'es',
  catalog: {}
}
vi.mock('@/store/plugin-language-packs', () => ({
  usePluginLanguagePackStore: <T,>(
    select: (source: { packs: PluginLanguagePackRegistration[] }) => T
  ) => select({ packs: [localPack] })
}))
vi.mock('./plugin-catalog-host-context', () => ({
  usePluginCatalogHost: () => ({
    settings: { uiLanguage: 'en' },
    languagePacks: [
      {
        ...localPack,
        id: 'plugin:company.languages/fr',
        locale: 'fr',
        resourceLanguage: 'pluginfr'
      }
    ],
    updateSettings: remoteUpdate
  })
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('applies the selected host’s language metadata to its preferences without touching desktop settings', async () => {
  remoteUpdate.mockResolvedValue(undefined)
  render(<PluginLanguageAction pluginKey="company.languages" />)
  await userEvent.click(screen.getByRole('button', { name: 'Use language' }))
  expect(remoteUpdate).toHaveBeenCalledWith({ uiLanguage: 'plugin:company.languages/fr' })
  expect(localUpdate).not.toHaveBeenCalled()
})
