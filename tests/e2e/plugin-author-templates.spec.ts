import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'

test('generated author templates install through the pinned catalog and supply locale, syntax and opened-file viewing', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ generatedTemplates: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  await writeFile(join(workspace, 'program.example'), '# author fixture\nlet count = 42\n')
  await writeFile(join(workspace, 'bytes.example-binary'), Uint8Array.of(0, 1, 2, 255))
  await fixture.runGit(workspace, ['init', '--quiet'])
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    for (const type of ['locale', 'syntax']) {
      const listing = page.locator(
        `[data-marketplace-plugin-key="fixture-author.template-${type}"]`
      )
      await expect(listing).toContainText(`${type} template`)
      await listing.getByRole('button', { name: 'Install', exact: true }).click()
      await expect(listing.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toHaveCount(0)
    }
    await page
      .locator('[data-marketplace-plugin-key="fixture-author.template-viewer"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    const preview = page.getByRole('dialog', { name: 'viewer template', exact: true })
    await expect(preview).toContainText('can read only the file you open with it')
    await expect(preview).toContainText('Community')
    await expect(preview).toContainText('fixture-author')
    await preview.getByRole('button', { name: 'Install plugin', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
    await expect(consent).toContainText('cannot save changes or access the network')
    await capturePluginEvidence(page, testInfo, 'author-template-viewer-review')
    await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await expect(consent).toBeHidden()
    await page.getByRole('tab', { name: /^Installed/ }).click()
    for (const type of ['locale', 'syntax', 'viewer']) {
      await expect(
        page.locator(`[data-plugin-key="fixture-author.template-${type}"]`)
      ).toContainText('Enabled')
    }
    await capturePluginEvidence(page, testInfo, 'author-template-installed')
    const locale = page.locator('[data-plugin-key="fixture-author.template-locale"]')
    await locale.getByRole('button', { name: 'Use language', exact: true }).click()
    await expect(locale).toContainText('Using language')
    await capturePluginEvidence(page, testInfo, 'author-template-locale')
    await page.evaluate(() =>
      window.__store?.getState().openSettingsTarget({ pane: 'appearance', repoId: null })
    )
    await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toBeVisible()
    const terminalSection = page.locator('button[aria-controls="appearance-section-terminal"]')
    if ((await terminalSection.getAttribute('aria-expanded')) === 'true') {
      await terminalSection.click()
    }
    await expect(terminalSection).toHaveAttribute('aria-expanded', 'false')
    const windowSection = page.locator('button[aria-controls="appearance-section-window"]')
    if ((await windowSection.getAttribute('aria-expanded')) === 'true') {
      await windowSection.click()
    }
    await expect(windowSection).toHaveAttribute('aria-expanded', 'false')
    await capturePluginEvidence(page, testInfo, 'author-template-translation')
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ workspace, worktreeId }) => {
        window.__store?.getState().openFile({
          filePath: workspace,
          relativePath: 'program.example',
          worktreeId,
          mode: 'edit',
          language: 'plaintext'
        })
      },
      { workspace: join(workspace, 'program.example'), worktreeId }
    )
    const line = page.locator('.monaco-editor .view-line').filter({ hasText: 'let count = 42' })
    await expect(line).toBeVisible()
    await expect
      .poll(() =>
        line
          .locator('span')
          .evaluateAll(
            (spans) =>
              new Set(
                spans
                  .filter((span) => !span.childElementCount && span.textContent?.trim())
                  .map((span) => getComputedStyle(span).color)
              ).size
          )
      )
      .toBeGreaterThan(1)
    await capturePluginEvidence(page, testInfo, 'author-template-syntax')
    await openFileExplorer(page)
    const file = page
      .locator('[data-file-explorer-row]')
      .filter({ has: page.getByText('bytes.example-binary', { exact: true }) })
    await expect(file).toBeVisible()
    await file.dblclick()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
          const frame = guest?.mainFrame.framesInSubtree.find(
            (candidate) => candidate !== guest.mainFrame
          )
          return frame ? frame.executeJavaScript('document.body?.innerText ?? ""') : ''
        })
      )
      .toContain('00 01 02 ff')
    await capturePluginEvidence(page, testInfo, 'author-template-viewer', app)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
