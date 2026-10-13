import { createServer } from 'node:net'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { environmentRecipeResourceSchema } from '../../src/shared/environment-recipe-protocol'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { capturePluginEvidence } from './helpers/plugin-evidence'

test('reviewed endpoint update preserves the saved host and survives restart without extra provider execution', async ({
  browserName: _browserName
}, testInfo) => {
  const template = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
  test.skip(!template, 'Requires the current source-built managed-server template')
  let connectionAttempts = 0
  const endpoint = createServer((socket) => {
    connectionAttempts += 1
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    endpoint.once('error', reject)
    endpoint.listen(0, '127.0.0.1', resolve)
  })
  const address = endpoint.address()
  if (!address || typeof address === 'string') {
    endpoint.close()
    throw new Error('The owned rejected SSH endpoint did not bind a TCP port')
  }
  const fixture = await createPluginCatalogFixture({
    environmentRecipes: true,
    environmentConnection: {
      type: 'ssh',
      host: '127.0.0.1',
      port: address.port,
      username: 'before',
      projectRoot: '/projects'
    }
  })
  const session = createRestartSession(testInfo, {
    ...fixture.gitEnvironment,
    ORCA_ORCAD_TEMPLATE_PATH: template!
  })
  let app: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  try {
    let launched = await session.launch({
      waitForStore: false,
      extraEnv: { NODE_ENV: 'production' }
    })
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
    const devbox = provider.locator('[data-environment-resource-id="devbox"]')
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    const firstReview = page.getByRole('dialog', { name: 'Connect to environment', exact: true })
    await expect(firstReview).toContainText(`before@127.0.0.1:${address.port}`)
    await capturePluginEvidence(page, testInfo, 'environment-endpoint-original-review-native', app)
    await firstReview.getByRole('button', { name: 'Save & connect', exact: true }).click()
    await expect(firstReview).toBeHidden()
    await expect(provider.getByRole('alert')).toContainText('saved')
    expect(connectionAttempts).toBeGreaterThan(0)
    const saved = await page.evaluate(async () =>
      (await window.api.ssh.listTargets()).find(
        (target) => target.environmentProvider?.resourceId === 'devbox'
      )
    )
    if (!saved) {
      throw new Error('The original reviewed provider target was not saved')
    }
    const inventoryFile = join(fixture.root, 'provider-executed.inventory.json')
    const inventory: unknown = JSON.parse(await readFile(inventoryFile, 'utf8'))
    if (!inventory || typeof inventory !== 'object' || !('devbox' in inventory)) {
      throw new Error('The fixture provider did not persist its devbox')
    }
    const previous = environmentRecipeResourceSchema.parse(inventory.devbox)
    if (!previous.connection) {
      throw new Error('The fixture devbox has no SSH endpoint')
    }
    await writeFile(
      inventoryFile,
      JSON.stringify({
        devbox: {
          ...previous,
          revision: 'r2',
          connection: { ...previous.connection, username: 'after' }
        }
      })
    )
    await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
    const nativeWindow = await app.browserWindow(page)
    try {
      await nativeWindow.evaluate((window) => window.setSize(1000, 720))
    } finally {
      await nativeWindow.dispose()
    }
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    const update = page.getByRole('dialog', {
      name: 'Update saved environment connection',
      exact: true
    })
    await expect(update).toContainText(`before@127.0.0.1:${address.port}`)
    await expect(update).toContainText(`after@127.0.0.1:${address.port}`)
    await expect(update.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await expect(
      update.getByRole('heading', { name: 'Update saved environment connection', exact: true })
    ).toBeInViewport()
    await expect(
      update.getByRole('button', { name: 'Update & connect', exact: true })
    ).toBeInViewport()
    await capturePluginEvidence(page, testInfo, 'environment-endpoint-update-review-native', app)
    await update
      .getByRole('region', { name: 'Connection details', exact: true })
      .evaluate((region) => {
        region.scrollTop = region.scrollHeight
      })
    await expect(
      update.getByRole('heading', { name: 'Update saved environment connection', exact: true })
    ).toBeInViewport()
    await expect(
      update.getByRole('button', { name: 'Update & connect', exact: true })
    ).toBeInViewport()
    await capturePluginEvidence(page, testInfo, 'environment-endpoint-update-scrolled-native', app)
    await update.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(
      await page.evaluate(
        async (id) => (await window.api.ssh.listTargets()).find((target) => target.id === id),
        saved.id
      )
    ).toEqual(saved)
    await devbox.getByRole('button', { name: 'Connect', exact: true }).click()
    await update.getByRole('button', { name: 'Update & connect', exact: true }).click()
    await expect(update).toBeHidden()
    await expect(provider.getByRole('alert')).toContainText('saved')
    const updated = await page.evaluate(
      async (id) => (await window.api.ssh.listTargets()).find((target) => target.id === id),
      saved.id
    )
    if (!updated) {
      throw new Error('The updated provider host was not saved')
    }
    expect(updated.id).toBe(saved.id)
    expect(updated.username).toBe('after')
    expect(updated.generation).toBeGreaterThan(saved.generation ?? 0)
    expect(updated.environmentProvider?.resourceRevision).toBe('r2')
    expect(updated.environmentProvider?.binding).toEqual(saved.environmentProvider?.binding)
    expect(updated.identityFile).toBe(saved.identityFile)
    const marker = await readFile(join(fixture.root, 'provider-executed'), 'utf8')
    expect(marker.trim().split('\n')).toHaveLength(5)
    const notice = page.getByRole('status', { name: 'Usage display is now compact', exact: true })
    if (await notice.isVisible()) {
      await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
    }
    await capturePluginEvidence(page, testInfo, 'environment-endpoint-updated-host-native', app)
    await session.close(app)
    app = null
    launched = await session.launch({ waitForStore: false, extraEnv: { NODE_ENV: 'production' } })
    app = launched.app
    page = launched.page
    expect(
      await page.evaluate(
        async (id) => (await window.api.ssh.listTargets()).find((target) => target.id === id),
        saved.id
      )
    ).toEqual(updated)
    expect(await readFile(join(fixture.root, 'provider-executed'), 'utf8')).toBe(marker)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    await capturePluginEvidence(page, testInfo, 'environment-endpoint-restarted-native', app)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(fixture.root, { recursive: true, force: true })
  }
})
