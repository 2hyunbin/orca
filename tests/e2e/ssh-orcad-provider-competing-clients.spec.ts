import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodePairingOffer } from '../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../src/shared/paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../../src/shared/remote-runtime-request-connection'
import { unwrapRuntimeRpcResult } from '../../src/shared/runtime-rpc-result'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { startHeadlessOracleHost } from './helpers/headless-layout-oracle-hosts'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import {
  installPluginEnvironmentProvider,
  openPluginEnvironmentHost
} from './helpers/plugin-environment-management'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

const hostName = 'Shared company control host'
const providerId = 'stablyai.orca-environments-devpods/devpods'

async function pairClient(page: Page, pairingCode: string): Promise<void> {
  await page.evaluate(
    async ({ pairingCode, name }) => {
      const added = await window.api.runtimeEnvironments.addFromPairingCode({ name, pairingCode })
      const connected = await window.api.runtimeEnvironments.connect({
        selector: added.environment.id
      })
      if (!connected.ok) {
        throw new Error('Could not pair the independent provider client')
      }
    },
    { pairingCode, name: hostName }
  )
}

test('independent desktops reject a stale machine action and withdraw another client’s SSH review', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(180_000)
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
  const firstSession = createRestartSession(testInfo)
  const secondSession = createRestartSession(testInfo)
  let host: Awaited<ReturnType<typeof startHeadlessOracleHost>> | undefined
  let first: Awaited<ReturnType<typeof firstSession.launch>> | undefined
  let second: Awaited<ReturnType<typeof secondSession.launch>> | undefined
  let observer: RemoteRuntimeRequestConnection | undefined
  try {
    host = await startHeadlessOracleHost('orcad', {
      grantDesktopControl: true,
      extraEnv: { NODE_ENV: 'production', ...fixture.gitEnvironment }
    })
    const launch = { waitForStore: false, extraEnv: { NODE_ENV: 'production' } }
    first = await firstSession.launch(launch)
    second = await secondSession.launch(launch)
    const firstOffer = decodePairingOffer(host.pairingUrl)
    await pairClient(first.page, host.pairingUrl)
    await host.restart()
    const secondOffer = decodePairingOffer(host.pairingUrl)
    expect(firstOffer.pairedDeviceId).toBeTruthy()
    expect(secondOffer.pairedDeviceId).toBeTruthy()
    expect(secondOffer.pairedDeviceId).not.toBe(firstOffer.pairedDeviceId)
    await pairClient(second.page, host.pairingUrl)
    const provider = await installPluginEnvironmentProvider(first.page, hostName)
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = first.page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(account).toBeHidden()
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const firstMachine = provider.locator('[data-environment-resource-id="devbox"]')
    await expect(firstMachine).toHaveAttribute('data-environment-state', 'running')
    await openPluginEnvironmentHost(second.page, hostName)
    await second.page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    const otherProvider = second.page.locator(`[data-environment-provider-id="${providerId}"]`)
    const secondMachine = otherProvider.locator('[data-environment-resource-id="devbox"]')
    await expect(secondMachine).toHaveAttribute('data-environment-state', 'running')
    const marker = join(fixture.root, 'provider-executed')
    const callsBeforeSleep = await readFile(marker, 'utf8')
    await firstMachine.getByRole('button', { name: 'Sleep', exact: true }).click()
    const stale = first.page.getByRole('dialog', { name: 'Sleep environment', exact: true })
    await expect(stale).toBeVisible()
    await secondMachine.getByRole('button', { name: 'Sleep', exact: true }).click()
    const current = second.page.getByRole('dialog', { name: 'Sleep environment', exact: true })
    await current.getByRole('button', { name: 'Sleep environment', exact: true }).click()
    await expect(current).toBeHidden()
    await expect(secondMachine).toHaveAttribute('data-environment-state', 'sleeping')
    const callsAfterSleep = await readFile(marker, 'utf8')
    expect(callsAfterSleep.trim().split('\n')).toHaveLength(
      callsBeforeSleep.trim().split('\n').length + 1
    )
    await expect(firstMachine).toHaveAttribute('data-environment-state', 'sleeping')
    await expect(stale).toContainText('devbox · r1')
    await stale.getByRole('button', { name: 'Sleep environment', exact: true }).click()
    await expect(stale).toBeHidden()
    const reopen = first.page.getByRole('button', { name: 'Reopen review', exact: true })
    await expect(reopen).toBeVisible()
    expect(await readFile(marker, 'utf8')).toBe(callsAfterSleep)
    await capturePluginEvidence(
      first.page,
      testInfo,
      'competing-client-stale-action-native',
      first.app
    )
    await reopen.click()
    await expect(firstMachine).toHaveAttribute('data-environment-state', 'sleeping')
    expect(await readFile(marker, 'utf8')).toBe(callsAfterSleep)
    await secondMachine.getByRole('button', { name: 'Wake', exact: true }).click()
    const wake = second.page.getByRole('dialog', { name: 'Wake environment', exact: true })
    await wake.getByRole('button', { name: 'Wake environment', exact: true }).click()
    await expect(wake).toBeHidden()
    await expect(firstMachine).toHaveAttribute('data-environment-state', 'running')
    await firstMachine.getByRole('button', { name: 'Connect', exact: true }).click()
    const connection = first.page.getByRole('dialog', {
      name: 'Connect to environment',
      exact: true
    })
    await expect(connection).toContainText('owned-fixture@127.0.0.1:9')
    await capturePluginEvidence(
      first.page,
      testInfo,
      'competing-client-pending-ssh-native',
      first.app
    )
    const callsBeforeDisable = await readFile(marker, 'utf8')
    await second.page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await second.page.getByRole('tab', { name: /^Installed/ }).click()
    await second.page
      .locator('[data-plugin-key="stablyai.orca-environments-devpods"]')
      .getByRole('switch', { name: 'Disable Development environments', exact: true })
      .click()
    await expect(provider).toHaveCount(0)
    await expect(connection).toBeHidden()
    const saved = first.page.locator(`[data-saved-environment-provider-id="${providerId}"]`)
    await saved.getByRole('button', { name: 'Show saved inventory', exact: true }).click()
    await expect(saved).toContainText('Existing development machine')
    await expect(
      saved.getByRole('button', { name: /^(Connect|Sleep|Wake|Delete|Archive)$/ })
    ).toHaveCount(0)
    expect(await readFile(marker, 'utf8')).toBe(callsBeforeDisable)
    observer = new RemoteRuntimeRequestConnection(pairedRuntimeConnectionFromOffer(firstOffer))
    const hostTargets = unwrapRuntimeRpcResult(
      await observer.request<{ targets: unknown[] }>('ssh.listEditableTargets', undefined, 15_000)
    )
    expect(hostTargets.targets).toEqual([])
    await capturePluginEvidence(
      first.page,
      testInfo,
      'competing-client-revoked-review-native',
      first.app
    )
    for (const client of [first, second]) {
      expect(await client.page.evaluate(() => Boolean(window.__store))).toBe(false)
      expect(await client.page.evaluate(() => window.api.ssh.listTargets())).toEqual([])
      expect(
        await client.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        )
      ).toBe(false)
    }
    await writeFile(
      join(getPluginEvidenceDirectory(), 'competing-clients-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Two independent production desktop profiles paired to one source-built Node controller; real Git, encrypted RPC and provider subprocesses',
          staleActionExecutesNoCommand: true,
          explicitReopenRestoresCurrentStateWithoutReplay: true,
          distinctAuthenticatedDevices: true,
          secondClientRevokesPendingSshReview: true,
          savedHistoryRetained: true,
          sshTargetsSaved: 0,
          nativeWindowsHidden: true,
          debugStoreExposed: false
        },
        null,
        2
      )
    )
  } finally {
    observer?.close()
    if (second) {
      await secondSession.close(second.app)
    }
    if (first) {
      await firstSession.close(first.app)
    }
    await secondSession.dispose()
    await firstSession.dispose()
    if (host) {
      await host.dispose()
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
})
