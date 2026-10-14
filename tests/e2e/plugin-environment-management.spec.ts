import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin'
import { installPluginEnvironmentProvider } from './helpers/plugin-environment-management'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

for (const portable of [false, true]) {
  test(`provider account setup and six lifecycle actions work through native host management (portable=${portable})`, async ({
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
      const provider = await installPluginEnvironmentProvider(page)
      await provider.getByRole('button', { name: 'Set up account', exact: true }).click()
      const account = page.getByRole('dialog', { name: 'Set up provider account', exact: true })
      await account
        .getByRole('textbox', { name: 'Account / tenant ID', exact: true })
        .fill('company/account/region')
      await captureEvidence(page, testInfo, 'environment-management-native-account-review', app)
      await account.getByRole('button', { name: 'Save account', exact: true }).click()
      await expect(account).toBeHidden()
      await expect(provider).toContainText('company/account/region')
      expect(existsSync(join(fixture.root, 'provider-executed'))).toBe(false)
      await provider.getByRole('button', { name: 'Refresh inventory', exact: true }).click()
      const devbox = provider.locator('[data-environment-resource-id="devbox"]')
      await expect(devbox).toContainText('Existing development machine')
      await expect(devbox).toHaveAttribute('data-environment-state', 'running')
      await captureEvidence(page, testInfo, 'environment-management-native-existing-devbox', app)
      await provider.getByRole('button', { name: 'Create environment', exact: true }).click()
      const create = page.getByRole('dialog', { name: 'Create environment', exact: true })
      await create.getByRole('combobox', { name: 'Region', exact: true }).click()
      await page.getByRole('option', { name: 'east', exact: true }).click()
      await captureEvidence(page, testInfo, 'environment-management-native-create-fields', app)
      await create.getByRole('button', { name: 'Create environment', exact: true }).click()
      await expect(create).toBeHidden()
      const sandbox = provider.locator('[data-environment-resource-id="sandbox"]')
      await expect(sandbox).toHaveAttribute('data-environment-state', 'running')
      await captureEvidence(page, testInfo, 'environment-management-native-created-sandbox', app)
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
        await captureEvidence(
          page,
          testInfo,
          `environment-management-native-${action.toLowerCase()}-review`,
          app
        )
        await review.getByRole('button', { name: title, exact: true }).click()
        await expect(review).toBeHidden()
        await expect(sandbox).toHaveAttribute('data-environment-state', state)
        await captureEvidence(page, testInfo, `environment-management-native-${state}`, app)
      }
      await expect(devbox).toHaveAttribute('data-environment-state', 'running')
      const invocations = (await readFile(join(fixture.root, 'provider-executed'), 'utf8'))
        .trim()
        .split('\n')
      expect(invocations).toHaveLength(6)
      const runtime = JSON.parse(
        await readFile(join(fixture.root, 'provider-executed.runtime.json'), 'utf8')
      )
      if (portable) {
        expect(runtime.version).toBe(`v${NODE_RUNTIME_PIN.version}`)
        expect(runtime.entry).toBe('dist/delete.mjs')
        await writeFile(
          join(getPluginEvidenceDirectory(), 'portable-environment-management-native-receipt.json'),
          JSON.stringify(
            {
              scope:
                'Owned repository-shipped adapters through the production desktop control host; six explicit lifecycle actions, no corporate service or physical power qualification',
              actions: ['list', 'create', 'sleep', 'resume', 'archive', 'delete'],
              actualProviderProcessInvocations: invocations.length,
              runtimeVersion: runtime.version,
              logicalFinalEntry: runtime.entry,
              runtimeInjected: false,
              debugStoreExposed: false,
              nativeWindowsHidden: true
            },
            null,
            2
          )
        )
      }
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
}
