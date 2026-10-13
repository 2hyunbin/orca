import { readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { publishCatalogFixtureRelease } from './helpers/plugin-catalog-fixture-release'
import { createRestartSession } from './helpers/orca-restart'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'
import { pluginManifestSchema } from '../../src/shared/plugins/plugin-manifest'
import { pluginEnvironmentRecipeSchema } from '../../src/shared/plugins/plugin-environment-recipe-artifact'

const providerSelector =
  '[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]'
test('an approved provider update requires fresh inventory review, keeps previous history and survives restart', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ environmentRecipes: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    const { page, app } = launched
    const usageNotice = page.getByRole('status', {
      name: 'Usage display is now compact',
      exact: true
    })
    if (await usageNotice.isVisible()) {
      await usageNotice.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    const provider = await installPluginEnvironmentProvider(page)
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    await expect(provider.locator('[data-environment-resource-id="devbox"]')).toBeVisible()
    const repository = join(fixture.root, 'repositories', 'orca-environments-devpods.git')
    const manifestPath = join(repository, 'orca-plugin.json')
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.1.0' }))
    const recipePath = join(repository, 'recipes', 'devpods.json')
    const recipe = pluginEnvironmentRecipeSchema.parse(
      JSON.parse(await readFile(recipePath, 'utf8'))
    )
    recipe.commands.list.args.push('--', 'updated-provider')
    await writeFile(recipePath, JSON.stringify(recipe))
    await publishCatalogFixtureRelease(fixture, 'orca-environments-devpods', '1.1.0')
    if (await usageNotice.isVisible()) {
      await usageNotice.getByRole('button', { name: 'Got it', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('tab', { name: /^All/ }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const listing = page.locator(
      '[data-marketplace-plugin-key="stablyai.orca-environments-devpods"]'
    )
    await expect(listing).toContainText('1.1.0')
    await listing.getByRole('button', { name: 'Check for update', exact: true }).click()
    const updateReview = page.getByRole('dialog', { name: 'Development environments', exact: true })
    await expect(updateReview).toContainText('Environment provider commands')
    await expect(
      updateReview.getByLabel('Development pods · List command', { exact: true })
    ).toContainText('updated-provider')
    await capturePluginEvidence(page, testInfo, 'environment-migration-native-update-commands', app)
    await updateReview.getByRole('button', { name: 'Approve and update', exact: true }).click()
    await expect(updateReview).toBeHidden()
    await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    await expect(provider).toContainText('source or commands changed')
    await expect(
      provider.getByRole('button', { name: 'Create environment', exact: true })
    ).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'environment-migration-native-source-fenced', app)
    await provider
      .getByRole('button', { name: 'Review configuration / switch account', exact: true })
      .click()
    const migration = page.getByRole('dialog', {
      name: 'Review provider configuration',
      exact: true
    })
    await migration.getByRole('button', { name: 'Check account', exact: true }).click()
    await expect(
      migration.getByRole('button', { name: 'Confirm configuration', exact: true })
    ).toBeEnabled()
    await expect(migration).toContainText('Existing development machine')
    await expect(migration).toContainText('workspaces and machines are not deleted')
    await capturePluginEvidence(page, testInfo, 'environment-migration-native-fresh-review', app)
    const nativeWindow = await app.browserWindow(page)
    try {
      await nativeWindow.evaluate((window) => window.setSize(1000, 720))
    } finally {
      await nativeWindow.dispose()
    }
    await expect(
      migration.getByRole('heading', { name: 'Review provider configuration', exact: true })
    ).toBeInViewport()
    await expect(
      migration.getByRole('button', { name: 'Confirm configuration', exact: true })
    ).toBeInViewport()
    await capturePluginEvidence(page, testInfo, 'environment-migration-native-narrow-review', app)
    await migration.getByRole('button', { name: 'Confirm configuration', exact: true }).click()
    await expect(migration).toBeHidden()
    await expect(
      provider.getByRole('button', { name: 'Create environment', exact: true })
    ).toBeEnabled()
    await provider.getByRole('button', { name: /^Previous configuration history/ }).click()
    await expect(provider).toContainText('Read-only history from a previous account or source')
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-migration-native-preserved-history',
      app
    )
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    await session.close(app)
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    const settings = launched.page.getByRole('button', { name: 'Settings', exact: true })
    if (await settings.isVisible()) {
      await settings.click()
    }
    await launched.page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    const restarted = launched.page.locator(providerSelector)
    await expect(
      restarted.getByRole('button', { name: 'Create environment', exact: true })
    ).toBeEnabled()
    await restarted.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    await expect(restarted.locator('[data-environment-resource-id="devbox"]')).toBeVisible()
    await capturePluginEvidence(
      launched.page,
      testInfo,
      'environment-migration-native-restarted',
      launched.app
    )
    expect(
      await launched.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
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
      join(getPluginEvidenceDirectory(), 'environment-migration-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Actual local Node CLI, pinned Git catalog update and native configuration/history/restart UI; no live corporate backend or paired control-host execution',
          builds,
          identity: await launched.page.evaluate(() => window.api.app.getIdentity()),
          nativeWindowsHidden: true,
          debugStoreExposed: false,
          assertions: [
            'source update requires new command approval',
            'old machine configuration remains fenced',
            'fresh list preview before selection',
            'previous source history remains read-only',
            'selected generation persists across restart'
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
