import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

async function dismissUsageNotice(page: Page): Promise<void> {
  const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  }
}

test('the selected host catalog installs and approves its provider before all six lifecycle actions', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({
    environmentRecipes: true,
    environmentPortable: true,
    environmentConnection: {
      type: 'ssh',
      host: '127.0.0.1',
      port: 9,
      username: 'owned-fixture',
      projectRoot: '/owned-project'
    }
  })
  const hostSession = createRestartSession(testInfo, fixture.gitEnvironment)
  const clientSession = createRestartSession(testInfo)
  const catalogMessages: string[] = []
  const observeCatalog = (page: Page): void => {
    page.on('console', (message) => {
      if (message.text().startsWith('[plugins]')) {
        catalogMessages.push(message.text())
      }
    })
  }
  let host: Awaited<ReturnType<typeof hostSession.launch>> | undefined
  let client: Awaited<ReturnType<typeof clientSession.launch>> | undefined
  try {
    const launch = { waitForStore: false, extraEnv: { NODE_ENV: 'production' } }
    host = await hostSession.launch(launch)
    observeCatalog(host.page)
    await host.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await dismissUsageNotice(host.page)
    await host.page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await host.page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
    expect(await host.page.evaluate(() => window.api.plugins.listEnvironmentProviders?.())).toEqual(
      []
    )
    const offer = await createRuntimeDesktopPairingOffer(host.page)
    client = await clientSession.launch(launch)
    observeCatalog(client.page)
    const { page, app } = client
    const capture = async (name: string): Promise<void> => {
      await dismissUsageNotice(page)
      await capturePluginEvidence(page, testInfo, name, app)
    }
    const environmentId = await page.evaluate(async (pairingCode) => {
      const added = await window.api.runtimeEnvironments.addFromPairingCode({
        name: 'Company control host',
        pairingCode
      })
      const response = await window.api.runtimeEnvironments.connect({
        selector: added.environment.id
      })
      if (!response.ok) {
        throw new Error('Owned control-host pairing failed')
      }
      return added.environment.id
    }, offer.pairingUrl)
    expect(await page.evaluate(() => window.api.plugins.listEnvironmentProviders?.())).toEqual([])
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
    if (await notice.isVisible()) {
      await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    await page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await page.getByRole('option', { name: 'Company control host', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(
      page.getByText('Managing plugins on Company control host', { exact: true })
    ).toBeVisible()
    await page.getByRole('combobox', { name: 'Plugin type', exact: true }).click()
    await page.getByRole('option', { name: 'Environment providers', exact: true }).click()
    await capture('remote-catalog-host-native')
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-environments-devpods"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    const preview = page.getByRole('dialog', { name: 'Development environments', exact: true })
    await expect(preview).toContainText('Managing plugins on Company control host')
    await capture('remote-catalog-release-review-native')
    await preview.getByRole('button', { name: 'Install plugin', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Review environment provider', exact: true })
    await expect(consent).toContainText('Managing plugins on Company control host')
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    expect(await page.evaluate(() => window.api.plugins.list())).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginKey: 'stablyai.orca-environments-devpods' })
      ])
    )
    await capture('remote-catalog-permissions-native')
    await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await expect(consent).toBeHidden()
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    expect(await page.evaluate(() => window.api.plugins.list())).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginKey: 'stablyai.orca-environments-devpods' })
      ])
    )
    expect(await host.page.evaluate(() => window.api.plugins.list())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginKey: 'stablyai.orca-environments-devpods', status: 'idle' })
      ])
    )
    await capture('remote-catalog-installed-native')
    await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    const providerId = 'stablyai.orca-environments-devpods/devpods'
    const provider = page.locator(`[data-environment-provider-id="${providerId}"]`)
    await expect(provider).toBeVisible()
    await expect(
      page.getByText('Provider commands run on Company control host.', { exact: true })
    ).toBeVisible()
    await capture('selected-host-provider-native')
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await expect(account).toContainText('Company control host')
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await capture('selected-host-account-native')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(account).toBeHidden()
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const devbox = provider.locator('[data-environment-resource-id="devbox"]')
    await expect(devbox).toHaveAttribute('data-environment-state', 'running')
    await capture('selected-host-inventory-native')
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    const sshReview = page.getByRole('dialog', { name: 'Connect to environment', exact: true })
    await expect(sshReview).toContainText('Company control host')
    await expect(sshReview).toContainText('owned-fixture@127.0.0.1:9')
    await expect(sshReview).toContainText(
      'SSH configuration, identity files and the agent belong to Company control host.'
    )
    await capture('remote-provider-ssh-review-native')
    await sshReview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(sshReview).toBeHidden()
    for (const ownPage of [page, host.page]) {
      expect(
        await ownPage.evaluate(async () =>
          (await window.api.ssh.listTargets()).some((target) => target.environmentProvider)
        )
      ).toBe(false)
    }

    await provider.getByRole('button', { name: 'Create environment', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create environment', exact: true })
    await expect(create).toContainText('Company control host')
    await create.getByRole('combobox', { name: 'Region', exact: true }).click()
    await page.getByRole('option', { name: 'east', exact: true }).click()
    await capture('selected-host-create-review-native')
    await create.getByRole('button', { name: 'Create environment', exact: true }).click()
    await expect(create).toBeHidden()
    const sandbox = provider.locator('[data-environment-resource-id="sandbox"]')
    await expect(sandbox).toHaveAttribute('data-environment-state', 'running')
    for (const [action, title, state] of [
      ['Sleep', 'Sleep environment', 'sleeping'],
      ['Wake', 'Wake environment', 'running'],
      ['Archive', 'Archive environment', 'archived'],
      ['Delete', 'Delete environment', 'deleted']
    ] as const) {
      await sandbox.getByRole('button', { name: action, exact: true }).click()
      const review = page.getByRole('dialog', { name: title, exact: true })
      await expect(review).toContainText('Company control host')
      await review.getByRole('button', { name: title, exact: true }).click()
      await expect(review).toBeHidden()
      await expect(sandbox).toHaveAttribute('data-environment-state', state)
      await capture(`selected-host-${state}-native`)
    }
    await expect(devbox).toHaveAttribute('data-environment-state', 'running')
    const marker = await readFile(join(fixture.root, 'provider-executed'), 'utf8')
    expect(marker.trim().split('\n')).toHaveLength(7)
    const runtime = JSON.parse(
      await readFile(join(fixture.root, 'provider-executed.runtime.json'), 'utf8')
    )
    expect(runtime.version).toBe(`v${NODE_RUNTIME_PIN.version}`)
    await page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await page.getByRole('option', { name: /^Local / }).click()
    await expect(provider).toHaveCount(0)
    await capture('selected-host-desktop-isolated-native')
    await page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await page.getByRole('option', { name: 'Company control host', exact: true }).click()
    await expect(sandbox).toHaveAttribute('data-environment-state', 'deleted')
    expect(await readFile(join(fixture.root, 'provider-executed'), 'utf8')).toBe(marker)
    await dismissUsageNotice(host.page)
    await host.page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await host.page.getByRole('tab', { name: /Installed/ }).click()
    await host.page
      .locator('[data-plugin-key="stablyai.orca-environments-devpods"]')
      .getByRole('switch', { name: 'Disable Development environments', exact: true })
      .click()
    await expect(provider).toHaveCount(0)
    const saved = page.locator(`[data-saved-environment-provider-id="${providerId}"]`)
    await saved.getByRole('button', { name: 'Show saved inventory', exact: true }).click()
    await expect(saved).toContainText('Existing development machine')
    await expect(saved).toContainText('Temporary sandbox')
    await capturePluginEvidence(
      page,
      testInfo,
      'selected-host-external-disable-history-native',
      app
    )
    expect(await readFile(join(fixture.root, 'provider-executed'), 'utf8')).toBe(marker)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(await host.page.evaluate(() => Boolean(window.__store))).toBe(false)
    for (const launched of [host, client]) {
      expect(
        await launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        )
      ).toBe(false)
    }
    await writeFile(
      join(getPluginEvidenceDirectory(), 'selected-host-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Two owned production desktop profiles with real encrypted paired RPC; selected-host provider UI; no corporate fleet or full Node deployment qualification',
          selectedEnvironmentId: environmentId,
          actualHostProviderInvocations: 7,
          explicitLifecycleActions: 6,
          sshReviewUsesControlHostInventoryWithoutSavingOrDialing: true,
          runtimeVersion: runtime.version,
          localProviderCatalogEmpty: true,
          catalogInstallAndApprovalOnSelectedHost: true,
          releaseAndConsentNameControlHost: true,
          installationAndApprovalExecuteNoProviderCode: true,
          userHostSwitchesPreserveHistoryWithoutExecution: true,
          externalHostDisablePublishesSavedHistory: true,
          debugStoreExposed: false,
          nativeWindowsHidden: true
        },
        null,
        2
      )
    )
  } finally {
    const evidence = getPluginEvidenceDirectory()
    if (existsSync(evidence)) {
      await writeFile(
        join(evidence, 'remote-catalog-console.json'),
        JSON.stringify(catalogMessages, null, 2)
      )
    }
    if (client) {
      await clientSession.close(client.app)
    }
    if (host) {
      await hostSession.close(host.app)
    }
    await clientSession.dispose()
    await hostSession.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
