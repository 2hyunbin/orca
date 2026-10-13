import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'
import { pluginMarketplaceSchema } from '../../src/shared/plugins/plugin-marketplace'

test('installs and applies a pinned SHA-256 language release through the catalog', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE
  const fixture = await createPluginCatalogFixture({ gitObjectFormat: 'sha256' })
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
    if (!('formatVersion' in catalog) || catalog.formatVersion !== 2) {
      throw new Error('SHA-256 fixture requires a pinned release')
    }
    const languageRelease = catalog.plugins.find(
      (plugin) => plugin.id === 'stablyai.orca-portuguese'
    )?.release
    if (!languageRelease) {
      throw new Error('SHA-256 language release missing')
    }
    expect(languageRelease.commit).toMatch(/^[0-9a-f]{64}$/)
    launched = await session.launch({
      executablePath,
      waitForStore: false,
      extraEnv: { NODE_ENV: 'production' }
    })
    const { page, app } = launched
    if (executablePath) {
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
      expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    }
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    const usageNotice = page.getByRole('status', { name: 'Usage is now compact', exact: true })
    if (await usageNotice.isVisible()) {
      await usageNotice.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(usageNotice).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    const language = page.locator('[data-marketplace-plugin-key="stablyai.orca-portuguese"]')
    await expect(language).toContainText('Portuguese (Brazil)')
    await language.getByRole('button', { name: 'Plugin details', exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Plugin details', exact: true })
    await expect(detail).toContainText(languageRelease.commit)
    await expect(detail).toContainText('No executable plugin code or host permissions')
    await capture(page, testInfo, 'git-sha256-exact-release', app)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await language.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(language.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    const installedRelease = await page.evaluate(async () =>
      (await window.api.plugins.list()).find(
        (plugin) => plugin.pluginKey === 'stablyai.orca-portuguese'
      )
    )
    expect(installedRelease?.source).toMatchObject({
      resolvedCommit: languageRelease.commit,
      contentHash: languageRelease.contentHash
    })
    expect(installedRelease?.hasWorker).toBe(false)
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    await capture(page, testInfo, 'git-sha256-installed-language', app)
    await page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = page.locator('[data-plugin-key="stablyai.orca-portuguese"]')
    await expect(installed).toContainText('Enabled')
    await installed.getByRole('button', { name: 'Use language', exact: true }).click()
    await expect(installed).toContainText('Using language')
    expect(
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label))
    ).toContain('Editar')
    await capture(page, testInfo, 'git-sha256-language-in-use', app)
    const evidence = join(process.cwd(), '.tmp', 'phase-o-1', 'evidence')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'git-object-format-native-identity.json'),
      `${JSON.stringify(
        {
          app: await app.evaluate(({ app, BrowserWindow }) => ({
            version: app.getVersion(),
            packaged: app.isPackaged,
            visibleWindows: BrowserWindow.getAllWindows().some((window) => window.isVisible())
          })),
          commit: languageRelease.commit,
          contentHash: languageRelease.contentHash,
          installedSource: installedRelease?.source,
          hasWorker: installedRelease?.hasWorker,
          storeHook: await page.evaluate(() => Boolean(window.__store))
        },
        null,
        2
      )}\n`
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
