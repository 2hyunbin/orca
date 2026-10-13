import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { capturePluginEvidence } from './helpers/plugin-evidence'

async function sshSettings(page: Page) {
  const ssh = page.getByRole('button', { name: 'SSH Hosts', exact: true })
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await expect.poll(async () => (await ssh.isVisible()) || (await settings.isVisible())).toBe(true)
  if (!(await ssh.isVisible())) {
    await settings.click()
  }
  await ssh.click()
}

async function installedProvider(page: Page) {
  const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
  if (!(await feature.isChecked())) {
    await feature.click()
  }
  await page.getByRole('tab', { name: /Installed/ }).click()
  const row = page.locator('[data-plugin-key="stablyai.orca-environments-devpods"]')
  await expect(row).toBeVisible()
  return row
}

test('disabled and removed providers retain readonly machine history across restart without executing commands', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ environmentRecipes: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  const providerId = 'stablyai.orca-environments-devpods/devpods'
  const launch = { waitForStore: false, extraEnv: { NODE_ENV: 'production' } }
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  try {
    let launched = await session.launch(launch)
    app = launched.app
    let page = launched.page
    const provider = await installPluginEnvironmentProvider(page)
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    await expect(provider).toContainText('Existing development machine')
    await provider.getByRole('button', { name: 'Create environment', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create environment', exact: true })
    await create.getByRole('combobox', { name: 'Region', exact: true }).click()
    await page.getByRole('option', { name: 'east', exact: true }).click()
    await create.getByRole('button', { name: 'Create environment', exact: true }).click()
    await expect(create).toBeHidden()
    await expect(provider).toContainText('Temporary sandbox')
    const marker = await readFile(join(fixture.root, 'provider-executed'), 'utf8')
    expect(marker.trim().split('\n')).toHaveLength(2)
    expect(
      marker
        .trim()
        .split('\n')
        .every((pid) => /^\d+$/.test(pid))
    ).toBe(true)
    const saved = () => page.locator(`[data-saved-environment-provider-id="${providerId}"]`)
    const showHistory = async () => {
      await sshSettings(page)
      await expect(saved()).toBeVisible()
      await saved().getByRole('button', { name: 'Show saved inventory', exact: true }).click()
      await expect(saved()).toContainText('Existing development machine')
      await expect(saved()).toContainText('Temporary sandbox')
      await expect(saved()).toContainText('Last recorded inventory')
      await saved().getByText('Operation history', { exact: false }).click()
      await expect(saved()).toContainText('Response received')
      for (const name of ['Connect', 'Sleep', 'Wake', 'Archive', 'Delete', 'Check with provider']) {
        await expect(saved().getByRole('button', { name, exact: true })).toHaveCount(0)
      }
      expect(await readFile(join(fixture.root, 'provider-executed'), 'utf8')).toBe(marker)
    }

    const row = await installedProvider(page)
    await row.getByRole('switch', { name: 'Disable Development environments', exact: true }).click()
    await showHistory()
    await capturePluginEvidence(page, testInfo, 'saved-provider-disabled-native', app)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
    await showHistory()
    await capturePluginEvidence(page, testInfo, 'saved-provider-system-off-native', app)
    await session.close(app)
    app = null
    launched = await session.launch(launch)
    app = launched.app
    page = launched.page
    await showHistory()
    await capturePluginEvidence(page, testInfo, 'saved-provider-disabled-restarted-native', app)

    await (
      await installedProvider(page)
    )
      .getByRole('switch', { name: 'Enable Development environments', exact: true })
      .click()
    await sshSettings(page)
    await expect(saved()).toHaveCount(0)
    await expect(page.locator(`[data-environment-provider-id="${providerId}"]`)).toContainText(
      'Existing development machine'
    )
    expect(await readFile(join(fixture.root, 'provider-executed'), 'utf8')).toBe(marker)
    await capturePluginEvidence(page, testInfo, 'saved-provider-enabled-native', app)

    await (
      await installedProvider(page)
    )
      .getByRole('button', { name: 'More actions for Development environments', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
    const remove = page.getByRole('dialog', { name: 'Remove plugin?', exact: true })
    await expect(remove).toContainText('Saved machine inventory and operation history remain')
    await expect(remove.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await capturePluginEvidence(page, testInfo, 'saved-provider-remove-review-native', app)
    await remove.getByRole('button', { name: 'Remove plugin', exact: true }).click()
    await expect(remove).toBeHidden()
    await showHistory()
    await session.close(app)
    app = null
    launched = await session.launch(launch)
    app = launched.app
    page = launched.page
    await showHistory()
    await capturePluginEvidence(page, testInfo, 'saved-provider-removed-restarted-native', app)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
