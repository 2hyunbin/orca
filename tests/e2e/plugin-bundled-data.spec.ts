import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

async function openPlugins(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
    window.__store?.getState().openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}
async function colors(line: Locator): Promise<number> {
  return line
    .locator('span')
    .evaluateAll(
      (spans) =>
        new Set(
          spans
            .filter((span) => !span.childElementCount && span.textContent?.trim())
            .map((span) => getComputedStyle(span).color)
        ).size
    )
}
async function menuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
  )
}

test('included data works with optional plugins off, preserves legacy choices, restores after disable and yields to an approved pin', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ syntaxPacks: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  const filePath = join(workspace, 'document.typ')
  await writeFile(filePath, '/* opens\n#let hidden = 12pt\n*/\n#let visible = 12pt\n')
  await fixture.runGit(workspace, ['init', '--quiet'])
  const session = createRestartSession(testInfo, {
    ...fixture.gitEnvironment,
    ORCA_STARTUP_DIAGNOSTICS: '1'
  })
  let startupLog = ''
  const launchOptions = {
    onStderr: (chunk: string) => {
      startupLog = (startupLog + chunk).slice(-64 * 1024)
    }
  }
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  const localeKey = 'stablyai.orca-locale-es'
  const syntaxKey = 'stablyai.orca-syntax-typst'
  const localeCard = (page: Page) => page.locator(`[data-bundled-plugin-key="${localeKey}"]`)
  const syntaxCard = (page: Page) => page.locator(`[data-bundled-plugin-key="${syntaxKey}"]`)
  try {
    launched = await session.launch(launchOptions)
    let { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await openPlugins(page)
    await expect(page.getByRole('switch', { name: 'Plugin system', exact: true })).not.toBeChecked()
    await expect(localeCard(page)).toContainText('Included v1.0.0')
    await expect(syntaxCard(page)).toContainText('Data only')
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'bundled-data-offline-settings', app)
    await page.evaluate(() => window.__store?.getState().updateSettingsOrThrow({ theme: 'dark' }))
    await expect(page.locator('html')).toHaveClass(/dark/)
    await capturePluginEvidence(page, testInfo, 'bundled-data-dark-settings', app)
    await page.evaluate(() => window.__store?.getState().updateSettingsOrThrow({ theme: 'light' }))
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await localeCard(page).getByRole('button', { name: 'Use language', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().settings?.uiLanguage))
      .toBe('es')
    await expect.poll(() => menuLabels(app)).toContain('Editar')
    await expect(localeCard(page)).toContainText('Using language')
    await capturePluginEvidence(page, testInfo, 'bundled-data-spanish-menu-and-settings', app)
    await localeCard(page).getByRole('switch').click()
    await expect(localeCard(page)).toContainText('Disabled')
    await expect.poll(() => menuLabels(app)).toContain('Edit')
    expect(await page.evaluate(() => window.__store?.getState().settings?.uiLanguage)).toBe('es')
    await localeCard(page).getByRole('switch').click()
    await expect.poll(() => menuLabels(app)).toContain('Editar')
    await localeCard(page).getByRole('switch').click()
    await expect.poll(() => menuLabels(app)).toContain('Edit')

    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ filePath, worktreeId }) =>
        window.__store?.getState().openFile({
          filePath,
          relativePath: 'document.typ',
          worktreeId,
          language: 'typst',
          mode: 'edit'
        }),
      { filePath, worktreeId }
    )
    const visible = () =>
      page.locator('.monaco-editor .view-line').filter({ hasText: '#let visible' }).first()
    const hidden = () =>
      page.locator('.monaco-editor .view-line').filter({ hasText: '#let hidden' }).first()
    await expect(visible()).toBeVisible()
    await expect.poll(() => colors(visible())).toBeGreaterThan(1)
    await expect.poll(() => colors(hidden())).toBe(1)
    await capturePluginEvidence(page, testInfo, 'bundled-data-typst-worker', app)
    await page.getByRole('combobox', { name: 'Choose syntax', exact: true }).click()
    await page.locator('[role="option"][data-value="plaintext"]').click()
    await expect.poll(() => colors(visible())).toBe(1)
    await session.close(app)
    launched = null
    launched = await session.launch(launchOptions)
    ;({ page, app } = launched)
    await page.evaluate(
      ({ filePath, worktreeId }) =>
        window.__store?.getState().openFile({
          filePath,
          relativePath: 'document.typ',
          worktreeId,
          language: 'typst',
          mode: 'edit'
        }),
      { filePath, worktreeId }
    )
    await expect(visible()).toBeVisible()
    await expect.poll(() => colors(visible())).toBe(1)
    await expect(page.getByRole('combobox', { name: 'Choose syntax', exact: true })).toHaveText(
      'Plain text'
    )
    await openPlugins(page)
    await expect(localeCard(page)).toContainText('Disabled')
    await expect(syntaxCard(page)).toContainText('Enabled')
    await syntaxCard(page).getByRole('switch').click()
    await expect(syntaxCard(page)).toContainText('Disabled')
    await capturePluginEvidence(page, testInfo, 'bundled-data-disabled-recovery', app)
    await syntaxCard(page).getByRole('switch').click()
    await expect(syntaxCard(page)).toContainText('Enabled')
    await page.keyboard.press('Escape')
    await page.getByRole('combobox', { name: 'Choose syntax', exact: true }).click()
    await page.locator('[role="option"][data-value="auto"]').click()
    await expect.poll(() => colors(visible())).toBeGreaterThan(1)

    await openPlugins(page)
    await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
    const listing = page.locator(`[data-marketplace-plugin-key="${syntaxKey}"]`)
    await expect(listing.getByRole('button', { name: 'Install', exact: true })).toBeVisible()
    await listing.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(syntaxCard(page)).toContainText('Using approved installed')
    const terminalNotice = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: "Couldn't verify which host owns this terminal" })
    if (await terminalNotice.isVisible()) {
      await terminalNotice.locator('[data-close-button]').click()
      await expect(terminalNotice).toBeHidden()
    }
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    const pinnedHash = (
      await readFile(join(session.userDataDir, 'plugins', syntaxKey, 'current'), 'utf8')
    ).trim()
    await capturePluginEvidence(page, testInfo, 'bundled-data-approved-override', app)
    await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
    await expect(syntaxCard(page)).toContainText('Included v1.0.0')
    expect(
      (await readFile(join(session.userDataDir, 'plugins', syntaxKey, 'current'), 'utf8')).trim()
    ).toBe(pinnedHash)
    await page.keyboard.press('Escape')
    await expect.poll(() => colors(visible())).toBeGreaterThan(1)
    await capturePluginEvidence(page, testInfo, 'bundled-data-pin-preserved-feature-off', app)
    const samples = [
      ...startupLog.matchAll(
        /\[startup\] plugin-system-initialized t=\d+ durationMs=([\d.]+) installedPlugins=(\d+)/g
      )
    ].map((match) => ({ durationMs: Number(match[1]), discoveredPlugins: Number(match[2]) }))
    const evidence = JSON.stringify(
      { environment: 'background macOS development build', samples },
      null,
      2
    )
    await testInfo.attach('bundled-data-startup-observations', {
      body: evidence,
      contentType: 'application/json'
    })
    await writeFile(
      join(getPluginEvidenceDirectory(), 'bundled-data-startup-observations.json'),
      evidence
    )
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
