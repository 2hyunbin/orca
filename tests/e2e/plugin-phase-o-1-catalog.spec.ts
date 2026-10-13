import { rm } from 'node:fs/promises'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'

test('browses pinned catalog cards and split details, filters and installs through real Git and IPC', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture()
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page } = launched
    await page.evaluate(() => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openSettingsTarget({ pane: 'plugins', repoId: null })
      state.openSettingsPage()
    })
    const section = page.locator('[data-settings-section="plugins"]')
    await expect(section).toBeVisible()
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    const language = page.locator('[data-marketplace-plugin-key="stablyai.orca-portuguese"]')
    await expect(language).toContainText('Portuguese (Brazil)')
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-nord-theme"]')
    ).toContainText('Nord appearance')
    await capture(page, testInfo, 'catalog-cards')
    await language.getByRole('button', { name: 'Plugin details' }).click()
    const detail = page.getByRole('dialog', { name: 'Plugin details' })
    await expect(detail).toContainText('No executable plugin code or host permissions')
    await expect(detail).toContainText('MIT')
    await capture(page, testInfo, 'catalog-package-detail')
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
    await expect(language.getByRole('button', { name: 'Plugin details' })).toBeFocused()
    await page.getByRole('tab', { name: 'Split', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Split', exact: true })).toHaveAttribute(
      'data-state',
      'active'
    )
    await expect(page.getByRole('complementary', { name: 'Plugin details' })).toContainText(
      'Release commit'
    )
    await capture(page, testInfo, 'catalog-split')
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'Interface languages' }).click()
    await expect(
      page.getByRole('navigation', { name: 'Plugin list' }).getByRole('button')
    ).toHaveCount(1)
    await page.getByRole('textbox', { name: 'Search plugins' }).fill('no-such-plugin')
    await expect(page.getByText('No matching plugins', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(page.getByRole('textbox', { name: 'Search plugins' })).toHaveValue('')
    await page.getByRole('tab', { name: 'Cards', exact: true }).click()
    await language.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(language.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    await capture(page, testInfo, 'catalog-one-action-install')
    await page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = page.locator('[data-plugin-key="stablyai.orca-portuguese"]')
    await expect(installed).toContainText('Enabled')
    await capture(page, testInfo, 'catalog-installed-language')
    await installed.getByRole('button', { name: 'Use language', exact: true }).click()
    await expect(installed).toContainText('Using language')
    await capture(page, testInfo, 'catalog-language-in-use')
    await page.evaluate(() =>
      window.__store?.getState().openSettingsTarget({ pane: 'appearance', repoId: null })
    )
    await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toContainText('pt-BR')
    await capture(page, testInfo, 'catalog-applied-language')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
