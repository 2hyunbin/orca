import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

for (const portable of [false, true]) {
  test(`environment providers have their own catalog category and executable command review (portable=${portable})`, async ({
    browserName: _browserName
  }, testInfo) => {
    const fixture = await createPluginCatalogFixture({
      environmentRecipes: true,
      environmentPortable: portable
    })
    const session = createRestartSession(testInfo, fixture.gitEnvironment)
    let launched: Awaited<ReturnType<typeof session.launch>> | null = null
    try {
      launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
      const { app, page } = launched
      const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
      if (await notice.isVisible()) {
        await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
      }
      const captureEvidence: typeof capturePluginEvidence = (page, info, name, app) =>
        capturePluginEvidence(page, info, portable ? `portable-${name}` : name, app)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
      if (!(await feature.isChecked())) {
        await feature.click()
      }
      await page.getByRole('combobox', { name: 'Plugin type', exact: true }).click()
      await page.getByRole('option', { name: 'Environment providers', exact: true }).click()
      const row = page.locator('[data-marketplace-plugin-key="stablyai.orca-environments-devpods"]')
      await expect(row).toContainText('Development environments')
      await expect(page.locator('[data-marketplace-plugin-key]')).toHaveCount(1)
      await expect(row).toContainText('Review required')
      await captureEvidence(page, testInfo, 'environment-provider-native-category', app)
      await row.getByRole('button', { name: 'Install', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Development environments', exact: true })
        .getByRole('button', { name: 'Install plugin', exact: true })
        .click()
      const review = page.getByRole('dialog', { name: 'Review environment provider', exact: true })
      await expect(review).toBeVisible()
      await expect(review).toContainText('commands run with your account on the selected host')
      await expect(review.getByRole('button', { name: 'Keep Disabled', exact: true })).toBeFocused()
      const commands = review.getByRole('region', {
        name: 'Plugin content and commands',
        exact: true
      })
      await expect(commands).toBeVisible()
      await captureEvidence(page, testInfo, 'environment-provider-native-command-review', app)
      for (const action of ['Create', 'List', 'Delete', 'Sleep', 'Resume / wake', 'Archive']) {
        const command = review.getByLabel(`Development pods · ${action} command`, { exact: true })
        await command.scrollIntoViewIfNeeded()
        await expect(command).toBeInViewport()
      }
      await expect(review).toContainText('Literal arguments')
      if (portable) {
        await expect(review).toContainText('Orca-provided Node runtime')
        await expect(review).toContainText('Reviewed adapter: dist/create.mjs')
        await expect(review).toContainText('account permissions, credentials and network access')
      }
      await expect(review).not.toContainText('validated content only')
      expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
      await expect(
        review.getByRole('heading', { name: 'Review environment provider' })
      ).toBeInViewport()
      await expect(
        review.getByText('These commands run with your account', { exact: false })
      ).toBeInViewport()
      await expect(
        review.getByRole('button', { name: 'Enable plugin', exact: true })
      ).toBeInViewport()
      await captureEvidence(page, testInfo, 'environment-provider-native-last-commands', app)
      const nativeWindow = await app.browserWindow(page)
      try {
        await nativeWindow.evaluate((window) => window.setSize(1000, 720))
      } finally {
        await nativeWindow.dispose()
      }
      await expect(
        review.getByRole('heading', { name: 'Review environment provider' })
      ).toBeInViewport()
      await expect(
        review.getByText('These commands run with your account', { exact: false })
      ).toBeInViewport()
      await expect(
        review.getByRole('button', { name: 'Enable plugin', exact: true })
      ).toBeInViewport()
      await captureEvidence(page, testInfo, 'environment-provider-native-narrow-review', app)
      await review.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(review).toBeHidden()
      const providers = await page.evaluate(() => window.api.plugins.list())
      const provider = providers.find(
        (entry) => entry.pluginKey === 'stablyai.orca-environments-devpods'
      )
      expect(provider).toMatchObject({
        status: 'idle',
        hasWorker: false,
        execution: 'instructional',
        environmentRecipeCount: 1
      })
      expect(provider?.environmentRecipes?.[0]?.commands).toHaveLength(6)
      expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
      expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        )
      ).toBe(false)
      await captureEvidence(page, testInfo, 'environment-provider-native-enabled', app)
      const builds = await Promise.all(
        ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map(
          async (path) => ({
            path,
            sha256: createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          })
        )
      )
      await writeFile(
        join(
          getPluginEvidenceDirectory(),
          portable
            ? 'portable-environment-provider-native-receipt.json'
            : 'environment-provider-native-receipt.json'
        ),
        JSON.stringify(
          {
            scope:
              'Provider catalog installation, command review and consent; no lifecycle UI execution',
            identity: await page.evaluate(() => window.api.app.getIdentity()),
            builds,
            debugStoreExposed: false,
            nativeWindowsHidden: true,
            commandsExecuted: false,
            provider: {
              pluginKey: provider?.pluginKey,
              execution: provider?.execution,
              status: provider?.status,
              declaredRecipes: provider?.environmentRecipeCount,
              commands: provider?.environmentRecipes?.[0]?.commands.map((command) => command.action)
            },
            assertions: [
              'first-class category',
              'current source/content consent',
              'literal argv',
              'all six commands',
              'fixed warning and actions while scrolling',
              'narrow layout',
              'no execution during install or approval'
            ]
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
}
