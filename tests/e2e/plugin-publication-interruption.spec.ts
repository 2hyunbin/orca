import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { publishViewerFixtureUpdate } from './helpers/plugin-viewer-fixture-release'
import { openPluginEnvironmentHost } from './helpers/plugin-environment-management'
import { forceQuitElectronAppForE2E } from './helpers/electron-process-shutdown'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'
import {
  pausePluginPublication,
  viewerFixtureReleaseHash
} from './helpers/plugin-publication-interruption'

const pluginKey = 'stablyai.orca-viewer-sample'

async function openPlugins(page: Page): Promise<void> {
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const back = page.getByRole('button', { name: 'Back to app', exact: true })
  await expect(settings.or(back).first()).toBeVisible()
  if (await settings.isVisible()) {
    await openPluginEnvironmentHost(page)
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
}

for (const boundary of ['before-pointer', 'before-index', 'after-index'] as const) {
  test(`force-quit during ${boundary} publication preserves exact viewer approval`, async ({
    browserName: _browserName
  }, testInfo) => {
    test.setTimeout(180_000)
    const fixture = await createPluginCatalogFixture({ viewerPack: true })
    const session = createRestartSession(testInfo, fixture.gitEnvironment)
    let launched: Awaited<ReturnType<typeof session.launch>> | null = null
    const launch = { waitForStore: false, extraEnv: { NODE_ENV: 'production' } }
    try {
      launched = await session.launch(launch)
      let { page, app } = launched
      await openPlugins(page)
      await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
      const listing = page.locator(`[data-marketplace-plugin-key="${pluginKey}"]`)
      await listing.getByRole('button', { name: 'Install', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Sample file viewer', exact: true })
        .getByRole('button', { name: 'Install plugin', exact: true })
        .click()
      const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
      await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(consent).toBeHidden()
      const previous = (await page.evaluate(() => window.api.plugins.list())).find(
        (plugin) => plugin.pluginKey === pluginKey
      )
      expect(previous).toMatchObject({ version: '1.0.0', status: 'idle', needsReconsent: false })
      const pluginsDirectory = join(session.userDataDir, 'plugins')
      const pluginDirectory = join(pluginsDirectory, pluginKey)
      const pointer = join(pluginDirectory, 'current')
      const lockfile = join(pluginsDirectory, 'plugins.lock.json')
      const previousHash = (await readFile(pointer, 'utf8')).trim()
      const previousLock = JSON.parse(await readFile(lockfile, 'utf8'))
      await publishViewerFixtureUpdate(fixture)
      const contentHash = await viewerFixtureReleaseHash(fixture)
      expect(contentHash).not.toBe(previousHash)
      await page.getByRole('tab', { name: /^All/ }).click()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(listing).toContainText('1.1.0')
      await listing.getByRole('button', { name: 'Check for update', exact: true }).click()
      const update = page.getByRole('dialog', { name: 'Sample file viewer', exact: true })
      await expect(update).toContainText('Your installed version (1.0.0) stays available')
      const marker = join(fixture.root, `${boundary}.json`)
      await pausePluginPublication({
        app,
        pluginDirectory,
        lockfile,
        contentHash,
        marker,
        boundary
      })
      await update.getByRole('button', { name: 'Approve and update', exact: true }).click()
      await expect.poll(() => existsSync(marker)).toBe(true)
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({
        pid: app.process().pid,
        boundary
      })
      await capturePluginEvidence(page, testInfo, `publication-${boundary}-pending-native`, app)
      await forceQuitElectronAppForE2E(app)
      launched = null
      const selectedHash = boundary === 'before-pointer' ? previousHash : contentHash
      expect((await readFile(pointer, 'utf8')).trim()).toBe(selectedHash)
      const interruptedLock = JSON.parse(await readFile(lockfile, 'utf8'))
      expect(interruptedLock.plugins[pluginKey].contentHash).toBe(
        boundary === 'after-index' ? contentHash : previousLock.plugins[pluginKey].contentHash
      )
      expect(existsSync(join(pluginDirectory, previousHash))).toBe(true)
      expect(existsSync(join(pluginDirectory, contentHash))).toBe(true)
      launched = await session.launch(launch)
      ;({ page, app } = launched)
      await openPlugins(page)
      await page.getByRole('tab', { name: /^Installed/ }).click()
      const installed = page.locator(`[data-plugin-key="${pluginKey}"]`)
      const recovered = (await page.evaluate(() => window.api.plugins.list())).find(
        (plugin) => plugin.pluginKey === pluginKey
      )
      if (boundary === 'before-pointer') {
        expect(recovered).toMatchObject({ version: '1.0.0', status: 'idle', needsReconsent: false })
        expect(recovered?.consentFingerprint).toBe(previous?.consentFingerprint)
        await expect(installed).toContainText('Enabled')
      } else {
        expect(recovered).toMatchObject({
          version: '1.1.0',
          status: 'pending',
          needsReconsent: true
        })
        expect(recovered?.consentFingerprint).not.toBe(previous?.consentFingerprint)
        await expect(installed).toContainText('Needs review')
        const viewers = await page.evaluate(() => window.api.plugins.listFileViewers?.())
        expect(viewers?.some((viewer) => viewer.pluginKey === pluginKey)).toBe(false)
      }
      const repairedLock = JSON.parse(await readFile(lockfile, 'utf8'))
      expect(repairedLock.plugins[pluginKey].contentHash).toBe(selectedHash)
      await capturePluginEvidence(page, testInfo, `publication-${boundary}-recovered-native`, app)
      if (boundary === 'before-index') {
        await installed
          .getByRole('button', { name: 'More actions for Sample file viewer', exact: true })
          .click()
        await page.getByRole('menuitem', { name: 'Roll back', exact: true }).click()
        const rollback = page.getByRole('dialog', { name: 'Roll back plugin?', exact: true })
        await rollback.getByRole('button', { name: 'Roll back plugin', exact: true }).click()
        await expect(rollback).toBeHidden()
        await expect(installed).toContainText('Enabled')
        expect((await readFile(pointer, 'utf8')).trim()).toBe(previousHash)
        expect(
          (await page.evaluate(() => window.api.plugins.list())).find(
            (plugin) => plugin.pluginKey === pluginKey
          )
        ).toMatchObject({ version: '1.0.0', status: 'idle', needsReconsent: false })
        await capturePluginEvidence(page, testInfo, 'publication-before-index-rollback-native', app)
      } else if (boundary === 'after-index') {
        await installed.getByRole('button', { name: 'Review & enable', exact: true }).click()
        await page
          .getByRole('dialog', { name: 'Review plugin', exact: true })
          .getByRole('button', { name: 'Enable plugin', exact: true })
          .click()
        await expect(installed).toContainText('Enabled')
        await expect
          .poll(() =>
            page.evaluate(
              async (key) =>
                (await window.api.plugins.listFileViewers?.())?.some(
                  (viewer) => viewer.pluginKey === key
                ),
              pluginKey
            )
          )
          .toBe(true)
        await capturePluginEvidence(page, testInfo, 'publication-after-index-reviewed-native', app)
      }
      expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        )
      ).toBe(false)
      const evidence = getPluginEvidenceDirectory()
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, `publication-${boundary}-receipt.json`),
        JSON.stringify(
          {
            boundary,
            previousHash,
            candidateHash: contentHash,
            selectedHash,
            actualForceQuit: true,
            publicationWasPending: true,
            indexRecoveredOnActualAppRestart: true,
            previousBytesRetained: true,
            newExecutableApprovalNotInherited: true,
            rollbackToPreviouslyApprovedBytes: boundary === 'before-index',
            nativeWindowsHidden: true,
            debugStoreExposed: false
          },
          null,
          2
        )
      )
    } finally {
      if (launched) {
        await session.close(launched.app)
      }
      await session.dispose()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
}
