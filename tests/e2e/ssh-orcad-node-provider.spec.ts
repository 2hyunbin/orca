import { runProcessSync } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import type { SshEditableTarget } from '../../src/shared/ssh-target-management'
import type { SshConnectionState } from '../../src/shared/ssh-types'
import type { OrcadManagedRuntimeStatus } from '../../src/shared/orcad-managed-runtime'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin'
import { decodePairingOffer } from '../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../src/shared/paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../../src/shared/remote-runtime-request-connection'
import { unwrapRuntimeRpcResult } from '../../src/shared/runtime-rpc-result'
import { startHeadlessOracleHost } from './helpers/headless-layout-oracle-hosts'
import { ensureDockerSshHostImage } from './helpers/docker-ssh-host-image'
import {
  startDockerSshHostTarget,
  cleanupDockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

async function dismissUsageNotice(page: Page): Promise<void> {
  const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  }
}

test.skip(
  process.env.ORCA_E2E_SSH_DOCKER !== '1',
  'Needs the source-built Node host and owned SSH container'
)

test('a paired desktop reviews a Node-host provider and connects, sleeps and wakes its SSH machine', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(300_000)
  await mkdir(getPluginEvidenceDirectory(), { recursive: true })
  ensureDockerSshHostImage(process.cwd())
  const target = startDockerSshHostTarget(testInfo)
  const fixture = await createPluginCatalogFixture({
    environmentRecipes: true,
    environmentPortable: true,
    environmentConnection: {
      type: 'ssh',
      host: target.host,
      port: target.port,
      username: 'root',
      projectRoot: '/tmp'
    }
  })
  const desktopSession = createRestartSession(testInfo)
  let host: Awaited<ReturnType<typeof startHeadlessOracleHost>> | undefined
  let desktop: Awaited<ReturnType<typeof desktopSession.launch>> | undefined
  let hostClient: RemoteRuntimeRequestConnection | undefined
  const consoleMessages: string[] = []
  try {
    host = await startHeadlessOracleHost('orcad', {
      grantDesktopControl: true,
      extraEnv: fixture.gitEnvironment
    })
    hostClient = new RemoteRuntimeRequestConnection(
      pairedRuntimeConnectionFromOffer(decodePairingOffer(host.pairingUrl))
    )
    desktop = await desktopSession.launch({
      waitForStore: false,
      extraEnv: { NODE_ENV: 'production' }
    })
    const { page, app } = desktop
    page.on('console', (message) => {
      if (message.text().startsWith('[plugins]')) {
        consoleMessages.push(message.text())
      }
    })
    const environmentId = await page.evaluate(async (pairingCode) => {
      const added = await window.api.runtimeEnvironments.addFromPairingCode({
        name: 'Company Node host',
        pairingCode
      })
      const connected = await window.api.runtimeEnvironments.connect({
        selector: added.environment.id
      })
      if (!connected.ok) {
        throw new Error('The Node host pairing failed')
      }
      return added.environment.id
    }, host.pairingUrl)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await dismissUsageNotice(page)
    await page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await page.getByRole('option', { name: 'Company Node host', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
    await expect(feature).not.toBeChecked()
    await feature.click()
    await page.getByRole('combobox', { name: 'Plugin type', exact: true }).click()
    await page.getByRole('option', { name: 'Environment providers', exact: true }).click()
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-environments-devpods"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    const release = page.getByRole('dialog', { name: 'Development environments', exact: true })
    await expect(release).toContainText('Company Node host')
    await capturePluginEvidence(page, testInfo, 'node-provider-release-native', app)
    await release.getByRole('button', { name: 'Install plugin', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Review environment provider', exact: true })
    await expect(consent).toContainText('Company Node host')
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    await capturePluginEvidence(page, testInfo, 'node-provider-consent-native', app)
    await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await expect(consent).toBeHidden()
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    expect(await page.evaluate(() => window.api.plugins.list())).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginKey: 'stablyai.orca-environments-devpods' })
      ])
    )
    await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()
    const provider = page.locator(
      '[data-environment-provider-id="stablyai.orca-environments-devpods/devpods"]'
    )
    await expect(provider).toBeVisible()
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(account).toBeHidden()
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const machine = provider.locator('[data-environment-resource-id="devbox"]')
    await expect(machine).toHaveAttribute('data-environment-state', 'running')
    await machine.getByRole('button', { name: 'Connect', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Connect to environment', exact: true })
    await expect(review).toContainText(`root@${target.host}:${target.port}`)
    await expect(review).toContainText(
      'SSH configuration, identity files and the agent belong to Company Node host.'
    )
    await review
      .getByRole('textbox', { name: 'Identity file (optional)', exact: true })
      .fill(target.identityFile)
    await capturePluginEvidence(page, testInfo, 'node-provider-ssh-review-native', app)
    const paused = runProcessSync({
      program: 'docker',
      args: ['pause', target.containerName],
      timeoutMs: 15_000
    })
    if (paused.code !== 0) {
      throw new Error('Could not pause the owned SSH fixture')
    }
    let unpauseFailed = false
    try {
      await review.getByRole('button', { name: 'Save & connect', exact: true }).click()
      await expect(review).toBeHidden()
      await expect(
        provider
          .getByRole('status')
          .filter({ hasText: 'Connecting to Existing development machine' })
      ).toContainText('Connecting to Existing development machine on Company Node host')
      await expect(machine.getByRole('button', { name: 'Sleep', exact: true })).toBeDisabled()
      await expect(
        provider.getByRole('button', { name: 'Refresh inventory', exact: true })
      ).toBeDisabled()
      await capturePluginEvidence(page, testInfo, 'node-provider-connecting-native', app)
    } finally {
      const resumed = runProcessSync({
        program: 'docker',
        args: ['unpause', target.containerName],
        timeoutMs: 15_000
      })
      unpauseFailed = resumed.code !== 0
    }
    if (unpauseFailed) {
      throw new Error('Could not resume the owned SSH fixture')
    }
    const targets = unwrapRuntimeRpcResult(
      await hostClient.request<{ targets: SshEditableTarget[] }>(
        'ssh.listEditableTargets',
        undefined,
        15_000
      )
    )
    const saved = targets.targets.find(
      (entry) => entry.host === target.host && entry.port === target.port
    )
    if (!saved) {
      throw new Error('The Node host did not save the provider target')
    }
    const state = async (): Promise<SshConnectionState> => {
      if (!hostClient) {
        throw new Error('The owned Node client is unavailable')
      }
      return unwrapRuntimeRpcResult(
        await hostClient.request<{ state: SshConnectionState }>(
          'ssh.getState',
          { targetId: saved.id },
          15_000
        )
      ).state
    }
    await expect
      .poll(async () => (await state())?.managedServer?.kind, { timeout: 90_000 })
      .toBe('managed')
    await expect(
      page.getByText('Connected to Existing development machine on Company Node host', {
        exact: true
      })
    ).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'node-provider-connection-confirmed-native', app)
    const connected = await state()
    const managed = connected.managedServer
    if (managed?.kind !== 'managed') {
      throw new Error('The provider machine has no managed runtime')
    }
    const server = unwrapRuntimeRpcResult(
      await hostClient.request<OrcadManagedRuntimeStatus>(
        'managedServer.status',
        { selector: managed.environmentId },
        60_000
      )
    )
    expect(server.terminals.liveSessions).toBe(0)
    expect(await page.evaluate(() => window.api.ssh.listTargets())).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.id })])
    )
    await capturePluginEvidence(page, testInfo, 'node-provider-ssh-connected-native', app)
    await machine.getByRole('button', { name: 'Sleep', exact: true }).click()
    const sleep = page.getByRole('dialog', { name: 'Sleep environment', exact: true })
    await sleep.getByRole('button', { name: 'Sleep environment', exact: true }).click()
    await expect(sleep).toBeHidden()
    await expect(machine).toHaveAttribute('data-environment-state', 'sleeping')
    await expect.poll(async () => (await state())?.status ?? 'disconnected').toBe('disconnected')
    await capturePluginEvidence(page, testInfo, 'node-provider-sleep-native', app)
    await machine.getByRole('button', { name: 'Wake', exact: true }).click()
    const wake = page.getByRole('dialog', { name: 'Wake environment', exact: true })
    await wake.getByRole('button', { name: 'Wake environment', exact: true }).click()
    await expect(wake).toBeHidden()
    await machine.getByRole('button', { name: 'Connect', exact: true }).click()
    const resume = page.getByRole('dialog', { name: 'Connect to environment', exact: true })
    await resume.getByRole('button', { name: 'Save & connect', exact: true }).click()
    await expect(resume).toBeHidden()
    await expect.poll(async () => (await state())?.status, { timeout: 60_000 }).toBe('connected')
    await expect
      .poll(async () => (await state()).managedServer, { timeout: 60_000 })
      .toMatchObject({
        kind: 'managed',
        environmentId: managed.environmentId
      })
    await capturePluginEvidence(page, testInfo, 'node-provider-wake-native', app)
    const runtime = JSON.parse(
      await readFile(join(fixture.root, 'provider-executed.runtime.json'), 'utf8')
    )
    expect(runtime.version).toBe(`v${NODE_RUNTIME_PIN.version}`)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    await writeFile(
      join(getPluginEvidenceDirectory(), 'node-provider-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Production paired desktop to packaged Darwin Node host to owned Linux SSH machine',
          environmentId,
          managedEnvironmentId: managed.environmentId,
          sshTargetId: saved.id,
          targetGeneration: saved.generation,
          providerRuntime: runtime.version,
          reviewedInstallExecutesNoProviderCode: true,
          credentialsAndTargetOnNodeHost: true,
          localTargetAbsent: true,
          realManagedDeployment: true,
          encryptedRemoteCensus: server.terminals,
          sleepRetiresContact: true,
          wakeKeepsManagedIdentity: true,
          nativeWindowsHidden: true,
          debugStoreExposed: false
        },
        null,
        2
      )
    )
  } finally {
    hostClient?.close()
    try {
      if (desktop) {
        await desktopSession.close(desktop.app)
      }
      await desktopSession.dispose()
    } finally {
      try {
        await host?.dispose()
      } finally {
        cleanupDockerSshHostTarget(target)
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
    await writeFile(
      join(getPluginEvidenceDirectory(), 'node-provider-console.json'),
      JSON.stringify(consoleMessages, null, 2)
    )
  }
})
