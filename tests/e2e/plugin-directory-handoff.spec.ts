import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect, test, type Browser } from '@stablyai/playwright-test'
import { createDirectoryFixtureServer } from '../plugin-directory/directory-fixture-server'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { capturePluginEvidence, getPluginEvidenceDirectory } from './helpers/plugin-evidence'

test('a public directory release installs with the same commit and hash and opens a real workbook in Orca', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({
    formatViewers: true,
    generatedTemplates: true
  })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let directory: Awaited<ReturnType<typeof createDirectoryFixtureServer>> | null = null
  let browser: Browser | null = null
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    directory = await createDirectoryFixtureServer(fixture)
    browser = await chromium.launch({ headless: true })
    const web = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      reducedMotion: 'reduce'
    })
    await web.goto(directory.url)
    await web.getByRole('button', { name: 'View XLSX tables' }).click()
    const source = {
      url: await web.getByRole('textbox', { name: 'Catalog Git URL' }).inputValue(),
      ref: await web.getByRole('textbox', { name: 'Catalog ref' }).inputValue()
    }
    await web.getByText('Release details', { exact: true }).click()
    const release = directory.directory.catalog.plugins.find(
      (plugin) => plugin.id === 'stablyai.orca-viewer-xlsx'
    )!
    await expect(web.getByRole('dialog')).toContainText(release.release.contentHash)
    await web.screenshot({
      path: join(getPluginEvidenceDirectory(), 'directory-native-handoff.png'),
      animations: 'disabled'
    })
    await browser.close()
    const workspaceDirectory = join(fixture.root, 'workspace')
    await mkdir(workspaceDirectory)
    const workspace = await realpath(workspaceDirectory)
    await cp(
      join(
        process.cwd(),
        'tests',
        'e2e',
        'fixtures',
        'plugin-format-corpus',
        'ProducedBudget.xlsx'
      ),
      join(workspace, 'ProducedBudget.xlsx')
    )
    await fixture.runGit(workspace, ['init', '--quiet'])
    launched = await session.launch()
    const { page, app } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const enabled = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await enabled.isChecked())) {
      await enabled.click()
    }
    await page.getByRole('button', { name: 'Manage sources' }).click()
    const sources = page.getByRole('dialog', { name: 'Marketplace sources' })
    await expect(sources).toContainText(source.url)
    const configured = await page.evaluate(() => window.api.plugins.listMarketplaces())
    expect(
      configured.some(
        (candidate) => candidate.source.url === source.url && candidate.source.ref === source.ref
      )
    ).toBe(true)
    await capturePluginEvidence(page, testInfo, 'directory-native-source', app)
    await sources.getByRole('button', { name: 'Done', exact: true }).click()
    await page
      .locator(`[data-marketplace-plugin-key="${release.id}"]`)
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    const preview = page.getByRole('dialog', { name: 'XLSX tables', exact: true })
    await expect(preview).toContainText('can read only the file you open with it')
    await preview.getByRole('button', { name: 'Install plugin', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
    await capturePluginEvidence(page, testInfo, 'directory-native-review', app)
    await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await expect(consent).toBeHidden()
    const installed = await page.evaluate(() => window.api.plugins.list())
    const actual = installed.find((plugin) => plugin.pluginKey === release.id)
    expect(actual?.source?.resolvedCommit).toBe(release.release.commit)
    expect(actual?.source?.contentHash).toBe(release.release.contentHash)
    expect(actual?.source?.marketplace?.resolvedCommit).toBe(
      await fixture.runGit(join(fixture.root, 'repositories', 'orca-plugins.git'), [
        'rev-parse',
        'HEAD'
      ])
    )
    await writeFile(
      join(getPluginEvidenceDirectory(), 'directory-native-release-proof.json'),
      JSON.stringify(
        {
          publicCatalog: source,
          publicRelease: release,
          installedSource: actual?.source,
          exactCommitAndHashMatch: true
        },
        null,
        2
      )
    )
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile({
          filePath,
          relativePath: 'ProducedBudget.xlsx',
          worktreeId,
          mode: 'edit',
          language: 'plaintext'
        })
      },
      { filePath: join(workspace, 'ProducedBudget.xlsx'), worktreeId }
    )
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
          if (!frame || !(await frame.executeJavaScript('Boolean(document.body)'))) {
            return null
          }
          return frame.executeJavaScript('document.body.innerText')
        })
      )
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'directory-native-workbook', app)
  } finally {
    await browser?.close()
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await directory?.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
