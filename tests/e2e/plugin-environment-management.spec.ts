import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence } from './helpers/plugin-evidence'

test('provider account setup and six lifecycle actions work through native host management', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ environmentRecipes: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    const { app, page } = launched
    const provider = await installPluginEnvironmentProvider(page)
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await capturePluginEvidence(page, testInfo, 'environment-management-native-account-review', app)
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(account).toBeHidden()
    await expect(provider).toContainText('company/account/region')
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const devbox = provider.locator('[data-environment-resource-id="devbox"]')
    await expect(devbox).toContainText('Existing development machine')
    await expect(devbox).toHaveAttribute('data-environment-state', 'running')
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-management-native-existing-devbox',
      app
    )
    await provider.getByRole('button', { name: 'Create environment', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create environment', exact: true })
    await create.getByRole('combobox', { name: 'Region', exact: true }).click()
    await page.getByRole('option', { name: 'east', exact: true }).click()
    await capturePluginEvidence(page, testInfo, 'environment-management-native-create-fields', app)
    await create.getByRole('button', { name: 'Create environment', exact: true }).click()
    await expect(create).toBeHidden()
    const sandbox = provider.locator('[data-environment-resource-id="sandbox"]')
    await expect(sandbox).toHaveAttribute('data-environment-state', 'running')
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-management-native-created-sandbox',
      app
    )
    for (const [action, title, state] of [
      ['Sleep', 'Sleep environment', 'sleeping'],
      ['Wake', 'Wake environment', 'running'],
      ['Archive', 'Archive environment', 'archived'],
      ['Delete', 'Delete environment', 'deleted']
    ] as const) {
      await sandbox.getByRole('button', { name: action, exact: true }).click()
      const review = page.getByRole('dialog', { name: title, exact: true })
      await expect(review).toContainText('Temporary sandbox')
      await expect(review).toContainText('sandbox')
      if (action === 'Archive' || action === 'Delete') {
        await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      }
      await capturePluginEvidence(
        page,
        testInfo,
        `environment-management-native-${action.toLowerCase()}-review`,
        app
      )
      await review.getByRole('button', { name: title, exact: true }).click()
      await expect(review).toBeHidden()
      await expect(sandbox).toHaveAttribute('data-environment-state', state)
      await capturePluginEvidence(page, testInfo, `environment-management-native-${state}`, app)
    }
    await expect(devbox).toHaveAttribute('data-environment-state', 'running')
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
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
