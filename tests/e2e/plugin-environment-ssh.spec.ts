import { readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'
import { callEnvironment } from './helpers/paired-host-terminal'
import {
  cleanupDockerSshHostTarget,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget
} from './helpers/docker-ssh-host-target'

test('provider machine review connects to a real SSH server and retires contact on sleep', async ({
  browserName: _browserName
}, testInfo) => {
  const template = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
  test.skip(
    !template || process.env.ORCA_E2E_SSH_DOCKER !== '1',
    'Requires the owned SSH container and current source-built server template'
  )
  test.setTimeout(240000)
  const target = startDockerSshHostTarget(testInfo)
  const folder = '/tmp/orca-provider-project'
  execDockerSshHostTargetCommand(target, `mkdir -p ${folder}`)
  const fixture = await createPluginCatalogFixture({
    environmentRecipes: true,
    environmentConnection: {
      type: 'ssh',
      host: target.host,
      port: target.port,
      username: 'root',
      projectRoot: folder
    }
  })
  const session = createRestartSession(testInfo, {
    ...fixture.gitEnvironment,
    ORCA_ORCAD_TEMPLATE_PATH: template!
  })
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    const { page, app } = launched
    const provider = await installPluginEnvironmentProvider(page)
    await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
    const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
    await account
      .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
      .fill('company/account/region')
    await account.getByRole('button', { name: 'Save account', exact: true }).click()
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const devbox = provider.locator('[data-environment-resource-id="devbox"]')
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Connect to environment', exact: true })
    await expect(review).toContainText(`root@${target.host}:${target.port}`)
    await expect(review).toContainText('company/account/region')
    await expect(review).toContainText(folder)
    await review
      .getByRole('textbox', { name: 'Identity file (optional)', exact: true })
      .fill(target.identityFile)
    await capturePluginEvidence(page, testInfo, 'environment-ssh-native-connection-review', app)
    await review.getByRole('button', { name: 'Save & connect', exact: true }).click()
    await expect(review).toBeHidden()
    const saved = await page.evaluate(async () =>
      (await window.api.ssh.listTargets()).find(
        (entry) => entry.environmentProvider?.resourceId === 'devbox'
      )
    )
    if (!saved) {
      throw new Error('The provider-owned saved SSH host is missing')
    }
    await expect
      .poll(
        async () =>
          page.evaluate(
            async (id) => (await window.api.ssh.getState({ targetId: id }))?.managedServer?.kind,
            saved.id
          ),
        { timeout: 90000 }
      )
      .toBe('managed')
    const environment = await page.evaluate(
      async (id) =>
        (await window.api.runtimeEnvironments.list()).find(
          (entry) => entry.orcadDeployment?.sshTargetId === id
        ),
      saved.id
    )
    if (!environment) {
      throw new Error('The existing SSH flow did not register the managed server')
    }
    const status = await callEnvironment(page, environment.id, 'status.get', {})
    expect(status).toMatchObject({ capabilities: expect.any(Array) })
    await capturePluginEvidence(page, testInfo, 'environment-ssh-native-connected-host', app)
    const group = await callEnvironment(page, environment.id, 'projectGroup.create', {
      name: 'Provider files',
      parentPath: folder
    })
    if (
      !group ||
      typeof group !== 'object' ||
      !('group' in group) ||
      !group.group ||
      typeof group.group !== 'object' ||
      !('id' in group.group)
    ) {
      throw new Error('The remote folder group was not created')
    }
    await callEnvironment(page, environment.id, 'folderWorkspace.create', {
      projectGroupId: group.group.id,
      name: 'Provider SSH folder',
      folderPath: folder
    })
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.getByText('Provider SSH folder', { exact: true }).click({ timeout: 30000 })
    const terminal = page.getByRole('textbox', { name: 'Terminal input', exact: true })
    await expect(terminal).toBeVisible()
    await expect(terminal.locator('xpath=ancestor::*[@data-pty-id][1]')).toHaveAttribute(
      'data-pty-id',
      /^remote:/
    )
    await terminal.pressSequentially(
      "printf 'ORCA_PROVIDER_SSH_OK\\n' > .orca-provider-proof; cat .orca-provider-proof; pwd"
    )
    await terminal.press('Enter')
    await expect
      .poll(
        () =>
          execDockerSshHostTargetCommand(
            target,
            `cat ${folder}/.orca-provider-proof 2>/dev/null || true`
          ),
        { timeout: 30000 }
      )
      .toBe('ORCA_PROVIDER_SSH_OK')
    expect(
      execDockerSshHostTargetCommand(target, `test ! -d ${folder}/.git && echo folder-without-git`)
    ).toBe('folder-without-git')
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-ssh-native-remote-folder-terminal',
      app
    )
    const usageNotice = page.getByRole('status', {
      name: 'Usage display is now compact',
      exact: true
    })
    if (await usageNotice.isVisible()) {
      await usageNotice.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'SSH Hosts', exact: true }).click()

    await devbox.getByRole('button', { name: 'Sleep', exact: true }).click()
    const sleep = page.getByRole('dialog', { name: 'Sleep environment', exact: true })
    await sleep.getByRole('button', { name: 'Sleep environment', exact: true }).click()
    await expect(sleep).toBeHidden()
    await expect(devbox).toHaveAttribute('data-environment-state', 'sleeping')
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) => (await window.api.ssh.getState({ targetId: id }))?.status ?? 'disconnected',
          saved.id
        )
      )
      .toBe('disconnected')
    expect(
      await page.evaluate(
        async (id) =>
          (await window.api.ssh.listTargets()).find((entry) => entry.id === id)?.environmentProvider
            ?.resourceId,
        saved.id
      )
    ).toBe('devbox')
    await capturePluginEvidence(page, testInfo, 'environment-ssh-native-sleep-retains-host', app)
    await devbox.getByRole('button', { name: 'Wake', exact: true }).click()
    const wake = page.getByRole('dialog', { name: 'Wake environment', exact: true })
    await wake.getByRole('button', { name: 'Wake environment', exact: true }).click()
    await expect(wake).toBeHidden()
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Connect to environment', exact: true })
      .getByRole('button', { name: 'Save & connect', exact: true })
      .click()
    await expect
      .poll(
        async () =>
          page.evaluate(
            async (id) => (await window.api.ssh.getState({ targetId: id }))?.managedServer?.kind,
            saved.id
          ),
        { timeout: 90000 }
      )
      .toBe('managed')
    expect(
      await page.evaluate(
        async (id) =>
          (await window.api.ssh.listTargets()).find((entry) => entry.id === id)?.generation,
        saved.id
      )
    ).toBe(saved.generation)
    await capturePluginEvidence(page, testInfo, 'environment-ssh-native-wake-reconnect', app)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    const builds = await Promise.all(
      [
        'out/main/index.js',
        'out/preload/index.js',
        'out/renderer/index.html',
        'out/orcad-template/orcad-template.json'
      ].map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      }))
    )
    await writeFile(
      join(getPluginEvidenceDirectory(), 'environment-ssh-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Owned local provider CLI plus actual Linux SSH server, native folder and terminal; provider sleep/wake changes fixture inventory rather than powering the container off',
          identity: await page.evaluate(() => window.api.app.getIdentity()),
          builds,
          debugStoreExposed: false,
          nativeWindowsHidden: true,
          sshTargetId: saved.id,
          registrationGeneration: saved.generation,
          providerId: saved.environmentProvider?.binding.providerId,
          contextId: saved.environmentProvider?.binding.contextId,
          resourceId: 'devbox',
          remoteFolder: folder,
          assertions: [
            'reviewed catalog installation',
            'fresh provider inventory',
            'fixed endpoint review',
            'normal SSH credentials and host trust',
            'managed server provisioning',
            'folder without Git',
            'real terminal input created remote marker',
            'sleep retires contact but keeps host and history',
            'wake and explicit review reconnect preserve generation'
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
      cleanupDockerSshHostTarget(target)
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})
