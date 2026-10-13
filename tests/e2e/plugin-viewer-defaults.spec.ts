import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'

test('Explorer resolves conflicts, remembers an explicit viewer, restores it, and recovers a missing default', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await createPluginCatalogFixture({ viewerPack: true, viewerConflict: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  await writeFile(join(workspace, 'notes.viewer-fixture'), 'A real file opened from Explorer')
  await fixture.runGit(workspace, ['init', '--quiet'])
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    await attachRepoAndOpenTerminal(launched.page, workspace)
    const settings = async (): Promise<void> => {
      await launched!.page.evaluate(() => {
        window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
        window.__store?.getState().openSettingsPage()
      })
    }
    await settings()
    let page = launched.page
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'File viewers' }).click()
    const listing = page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]')
    await listing.getByRole('button', { name: 'Install', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Sample file viewer', exact: true })
      .getByRole('button', { name: 'Install plugin', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Review plugin', exact: true })
      .getByRole('button', { name: 'Enable plugin', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toBeHidden()
    await page.keyboard.press('Escape')
    const openFromExplorer = async (): Promise<void> => {
      const current = launched!.page
      await openFileExplorer(current)
      const row = current
        .locator('[data-file-explorer-row]')
        .filter({ has: current.getByText('notes.viewer-fixture', { exact: true }) })
      await expect(row).toBeVisible()
      await row.dblclick()
    }
    const closeFile = async (): Promise<void> => {
      await launched!.page
        .locator('[data-tab-id]')
        .filter({ hasText: 'notes.viewer-fixture' })
        .getByRole('button', { name: /^Close tab/ })
        .click()
    }
    const parserText = async (): Promise<string> =>
      launched!.app.evaluate(async ({ webContents }) => {
        const guest = webContents
          .getAllWebContents()
          .find((item) => item.getURL().startsWith('orca-plugin-viewer://'))
        const frame = guest?.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
        const text = frame ? await frame.executeJavaScript('document.body.innerText') : ''
        return typeof text === 'string' ? text : ''
      })
    await openFromExplorer()
    await expect(page.locator('[data-file-opening]')).toContainText(
      'Several viewers match this file'
    )
    await expect(page.locator('[data-plugin-file-viewer]')).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'viewer-conflict-choice')
    await session.close(launched.app)
    launched = await session.launch()
    page = launched.page
    await expect(page.locator('[data-file-opening]')).toContainText(
      'Several viewers match this file'
    )
    await expect(page.locator('[data-plugin-file-viewer]')).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'viewer-pending-restart')
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open once', exact: true })).toBeDisabled()
    const search = page.getByRole('combobox', { name: 'Search viewers…', exact: true })
    await search.fill('Sample file')
    await search.press('ArrowDown')
    await search.press('Enter')
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect.poll(parserText).toContain('A real file opened from Explorer')
    await capturePluginEvidence(page, testInfo, 'viewer-open-once', launched.app)
    await closeFile()
    await openFromExplorer()
    await expect(page.locator('[data-file-opening]')).toContainText(
      'Several viewers match this file'
    )
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Alternate sample' }).click()
    await page
      .getByRole('checkbox', { name: 'Always use for .viewer-fixture files', exact: true })
      .check()
    await capturePluginEvidence(page, testInfo, 'viewer-save-default')
    await page.getByRole('button', { name: 'Set default and open', exact: true }).click()
    await expect.poll(parserText).toContain('A real file opened from Explorer')
    await closeFile()
    await openFromExplorer()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect(page.locator('[data-file-opening]')).toHaveCount(0)
    await session.close(launched.app)
    launched = await session.launch()
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect.poll(parserText).toContain('A real file opened from Explorer')
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await expect(
      launched.page.getByRole('option').filter({ hasText: 'Alternate sample' })
    ).toContainText('Current')
    await expect(
      launched.page.getByRole('option').filter({ hasText: 'Alternate sample' })
    ).toContainText('Default')
    await capturePluginEvidence(launched.page, testInfo, 'viewer-default-restart', launched.app)
    await launched.page.keyboard.press('Escape')
    await settings()
    await launched.page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = launched.page.locator('[data-plugin-key="stablyai.orca-viewer-sample"]')
    await installed.getByRole('switch').click()
    await expect(installed).toContainText('Disabled')
    await launched.page.keyboard.press('Escape')
    await closeFile()
    await openFromExplorer()
    await expect(launched.page.locator('[data-file-opening]')).toContainText(
      'The saved viewer is disabled, missing, or incompatible'
    )
    await expect(launched.page.locator('[data-file-opening]')).toContainText(
      'viewer:stablyai.orca-viewer-sample/alternate'
    )
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toHaveCount(0)
    await capturePluginEvidence(launched.page, testInfo, 'viewer-missing-default')
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await launched.page.getByRole('button', { name: 'Reset default', exact: true }).click()
    await expect(
      launched.page.getByRole('button', { name: 'Reset default', exact: true })
    ).toHaveCount(0)
    await launched.page.getByRole('option').filter({ hasText: 'Orca viewer' }).click()
    await launched.page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText(
      'A real file opened from Explorer'
    )
    await capturePluginEvidence(launched.page, testInfo, 'viewer-default-reset')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
