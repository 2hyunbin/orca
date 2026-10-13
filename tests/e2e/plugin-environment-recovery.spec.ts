import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

test('an interrupted creation is recovered from its provider receipt without replaying the change', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({
    environmentRecipes: true,
    environmentRecovery: { interruptCreate: true }
  })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
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
    expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
    await provider.getByRole('button', { name: 'Create environment', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Create environment', exact: true })
    await create.getByRole('button', { name: 'Create environment', exact: true }).click()
    const receiptsFile = join(fixture.root, 'provider-executed.receipts.json')
    await expect.poll(() => existsSync(receiptsFile)).toBe(true)
    const before = JSON.parse(await readFile(receiptsFile, 'utf8'))
    const originalOperationId = Object.keys(before)[0]
    expect(originalOperationId).toBeTruthy()
    expect(before[originalOperationId].outcome.resource.id).toBe('sandbox')
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-recovery-native-applied-before-response',
      app
    )
    await create.getByRole('button', { name: 'Stop command', exact: true }).click()
    await expect(create.getByRole('alert')).toBeVisible()
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    const unresolved = provider.locator(`[data-environment-operation-id="${originalOperationId}"]`)
    await expect(unresolved).toContainText('Unresolved machine change')
    await expect(
      provider.getByRole('button', { name: 'Create environment', exact: true })
    ).toBeDisabled()
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-recovery-native-unresolved-history',
      app
    )
    await unresolved.getByRole('button', { name: 'Check with provider', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Check interrupted operation', exact: true })
    await expect(review).toContainText(originalOperationId)
    await expect(review).toContainText('company/account/region')
    await expect(review).toContainText('does not rerun')
    await capturePluginEvidence(page, testInfo, 'environment-recovery-native-receipt-review', app)
    await review.getByRole('button', { name: 'Check with provider', exact: true }).click()
    await expect(review).toBeHidden()
    const sandbox = provider.locator('[data-environment-resource-id="sandbox"]')
    await expect(sandbox).toHaveAttribute('data-environment-state', 'running')
    await expect(unresolved).toHaveCount(0)
    await expect(provider.getByRole('alert')).toHaveCount(0)
    await expect(
      provider.getByRole('button', { name: 'Create environment', exact: true })
    ).toBeEnabled()
    await provider.locator('summary').filter({ hasText: 'Operation history' }).click()
    const confirmed = provider.locator(`[data-environment-history-id="${originalOperationId}"]`)
    await expect(confirmed).toContainText('Provider confirmed completion')
    await expect(confirmed).toContainText('Original observation kept')
    await expect(confirmed).toContainText('Not confirmed')
    expect(Object.keys(JSON.parse(await readFile(receiptsFile, 'utf8')))).toEqual([
      originalOperationId
    ])
    await capturePluginEvidence(
      page,
      testInfo,
      'environment-recovery-native-confirmed-and-retained',
      app
    )
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
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
      join(getPluginEvidenceDirectory(), 'environment-recovery-native-receipt.json'),
      JSON.stringify(
        {
          scope:
            'Actual local Node provider CLI fixture applied creation, lost its response, was cancelled and answered a separately reviewed receipt query; no live corporate backend',
          identity: await page.evaluate(() => window.api.app.getIdentity()),
          builds,
          originalOperationId,
          originalObservation: 'unverifiable/cancelled',
          confirmedBackendOutcome: 'completed',
          mutationReceipts: 1,
          debugStoreExposed: false,
          nativeWindowsHidden: true,
          assertions: [
            'install/account setup executes no command',
            'backend applied create before response loss',
            'stop keeps uncertainty and blocks another create',
            'review pins source/account/original operation',
            'separate provider receipt confirms original request digest',
            'current machine inventory appears',
            'history retains interrupted observation',
            'original mutation is not replayed'
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
