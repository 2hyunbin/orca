import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { pluginMarketplaceSchema } from '../../src/shared/plugins/plugin-marketplace'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import {
  capturePluginEvidence as capture,
  getPluginEvidenceDirectory
} from './helpers/plugin-evidence'

test('marketplace browsing presents inert previews, execution declarations and exact release details', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ syntaxPacks: true, formatViewers: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    const catalog = pluginMarketplaceSchema.parse(
      JSON.parse(
        await readFile(
          join(fixture.root, 'repositories', 'orca-plugins.git', 'orca-marketplace.json'),
          'utf8'
        )
      )
    )
    if (!('formatVersion' in catalog)) {
      throw new Error('review fixture requires a pinned catalog')
    }
    const release = catalog.plugins.find(
      (plugin) => plugin.id === 'stablyai.orca-portuguese'
    )!.release
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    const { page, app } = launched
    const usage = page.getByRole('status', { name: 'Usage is now compact', exact: true })
    if (await usage.isVisible()) {
      await usage.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    const language = page.locator('[data-marketplace-plugin-key="stablyai.orca-portuguese"]')
    await expect(language.getByLabel('Publisher preview')).toContainText('Abrir arquivo')
    await expect(language).toContainText('Declared data pack')
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-syntax-typst"]')
    ).toContainText('#let answer = 12pt')
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-xlsx"]')
    ).toContainText('Review required')
    await capture(page, testInfo, 'adversarial-native-browse-cards', app)
    const trigger = language.getByRole('button', { name: 'Plugin details', exact: true })
    await trigger.click()
    const detail = page.getByRole('dialog', { name: 'Plugin details', exact: true })
    await expect(detail).toContainText(release.commit)
    await expect(detail).toContainText(release.contentHash)
    await expect(detail).toContainText('Declared execution')
    if (await usage.isVisible()) {
      await usage.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    await capture(page, testInfo, 'adversarial-native-exact-release', app)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page
      .getByRole('radiogroup', { name: 'Theme', exact: true })
      .getByRole('radio', { name: 'Dark', exact: true })
      .click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const ownedWindow = await app.browserWindow(page)
    try {
      await ownedWindow.evaluate((window) => window.setSize(1100, 900))
    } finally {
      await ownedWindow.dispose()
    }
    await expect(language.getByLabel('Publisher preview')).toContainText('Abrir arquivo')
    await language.scrollIntoViewIfNeeded()
    await capture(page, testInfo, 'adversarial-native-dark-narrow', app)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    const evidence = getPluginEvidenceDirectory()
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'adversarial-native-review-identity.json'),
      JSON.stringify(
        {
          identity: await page.evaluate(() => window.api.app.getIdentity()),
          version: await app.evaluate(({ app }) => app.getVersion()),
          packaged: await app.evaluate(({ app }) => app.isPackaged),
          storeHook: await page.evaluate(() => Boolean(window.__store)),
          displayedRelease: release,
          visibleWindows: false
        },
        null,
        2
      )
    )
  } finally {
    try {
      if (launched) {
        await session.close(launched.app)
      }
    } finally {
      await session.dispose()
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})
