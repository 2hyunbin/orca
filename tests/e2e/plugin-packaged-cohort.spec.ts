import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { capturePluginViewerProcessEvidence } from './helpers/plugin-viewer-process-evidence'

async function openPlugins(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function visibleViewerText(page: Page, app: ElectronApplication): Promise<string> {
  const url = await page.locator('[data-plugin-file-viewer]:visible webview').getAttribute('src')
  return app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((guest) => guest.getURL() === url)
    const frame = guest?.mainFrame.framesInSubtree.find((frame) => frame !== guest.mainFrame)
    const text = frame ? await frame.executeJavaScript('document.body.innerText') : ''
    return typeof text === 'string' ? text : ''
  }, url)
}

test('the real production package preserves legacy language choice, opens its bundled grammar and installed binary viewers through restart', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_PHASE_O_1_PACKAGED_EXECUTABLE to a built production package')
  test.setTimeout(180_000)
  expect(executablePath && existsSync(executablePath)).toBe(true)
  const fixture = await createPluginCatalogFixture({ formatViewers: true, syntaxPacks: true })
  const documents = join(fixture.root, 'Documents')
  await mkdir(documents)
  const folderPath = await realpath(documents)
  const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
  const workbookPath = join(folderPath, 'ProducedBudget.xlsx')
  await cp(join(corpus, 'ProducedBudget.xlsx'), workbookPath)
  await cp(join(corpus, 'Pyramid.stl'), join(folderPath, 'Pyramid.stl'))
  await writeFile(join(folderPath, 'Included.typ'), '#let packaged = 12pt\n')
  await writeFile(join(folderPath, 'Community.orcasample'), 'launch "package" 42\n')
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  const profilePath = join(session.userDataDir, 'orca-data.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.settings.uiLanguage = 'es'
  profile.settings.pluginSystemEnabled = false
  await writeFile(profilePath, JSON.stringify(profile))
  const launchOptions = {
    executablePath,
    waitForStore: false,
    extraEnv: { NODE_ENV: 'production' }
  }
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch(launchOptions)
    let { page, app } = launched
    const identity = await app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resources: process.resourcesPath,
      version: app.getVersion(),
      visibleWindows: BrowserWindow.getAllWindows().some((window) => window.isVisible())
    }))
    expect(identity.packaged).toBe(true)
    expect(identity.visibleWindows).toBe(false)
    expect(identity.appPath).toContain('app.asar')
    expect(
      await app.evaluate(({ app }) => {
        const fs = process.getBuiltinModule('fs')
        const path = process.getBuiltinModule('path')
        return ['.tmp', 'plugin-packages', 'out/plugin-directory'].map((entry) =>
          fs.existsSync(path.join(app.getAppPath(), entry))
        )
      })
    ).toEqual([false, false, false])
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label))
      )
      .toContain('Editar')
    expect((await page.evaluate(() => window.api.settings.get())).uiLanguage).toBe('es')
    await page.evaluate(() => window.api.settings.set({ uiLanguage: 'en' }))
    await page.reload()
    await expect
      .poll(() =>
        app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label))
      )
      .toContain('Edit')
    await openPlugins(page)
    const locale = page.locator('[data-bundled-plugin-key="stablyai.orca-locale-es"]')
    const syntax = page.locator('[data-bundled-plugin-key="stablyai.orca-syntax-typst"]')
    await expect(locale).toContainText('Included v1.0.0')
    await expect(syntax).toContainText('Data only')
    const feature = page.getByRole('switch', { name: 'Plugin system', exact: true })
    await expect(feature).not.toBeChecked()
    await capturePluginEvidence(page, testInfo, 'packaged-included-data', app)
    await feature.click()
    for (const format of [
      { id: 'xlsx', title: 'XLSX tables' },
      { id: 'stl', title: 'STL models' }
    ]) {
      await page.getByRole('tab', { name: /^All/ }).click()
      await page
        .locator(`[data-marketplace-plugin-key="stablyai.orca-viewer-${format.id}"]`)
        .getByRole('button', { name: 'Install', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: format.title, exact: true })
        .getByRole('button', { name: 'Install plugin', exact: true })
        .click()
      const review = page.getByRole('dialog', { name: 'Review plugin', exact: true })
      await expect(review).toContainText('can read only the file you open with it')
      await review.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(review).toBeHidden()
    }
    await page.getByRole('tab', { name: /^All/ }).click()
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-syntax-sample"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await expect(page.locator('[data-plugin-key="stablyai.orca-syntax-sample"]')).toContainText(
      'Enabled'
    )
    await capturePluginEvidence(page, testInfo, 'packaged-installed-cohort', app)
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Packaged documents',
        parentPath: folderPath
      })
      await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Packaged folder',
        folderPath
      })
    }, folderPath)
    await page.getByText('Packaged folder', { exact: true }).click()
    const explorer = page.getByRole('button', { name: /^Explorer/ })
    if (!(await explorer.isVisible())) {
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click()
    }
    await explorer.click()
    const open = async (name: string): Promise<void> => {
      const row = page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
      await expect(row).toBeVisible()
      await row.dblclick()
    }
    for (const name of ['Included.typ', 'Community.orcasample']) {
      await open(name)
      const line = page.locator('.monaco-editor:visible .view-line').first()
      await expect(line).toContainText(name === 'Included.typ' ? '#let packaged' : 'launch')
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
      await capturePluginEvidence(
        page,
        testInfo,
        name === 'Included.typ' ? 'packaged-included-grammar' : 'packaged-community-grammar',
        app
      )
    }
    const stlProof = await capturePluginViewerProcessEvidence(
      app,
      testInfo,
      async () => {
        await open('Pyramid.stl')
        await expect
          .poll(async () => {
            const url = await page
              .locator('[data-plugin-file-viewer]:visible webview')
              .getAttribute('src')
            return app.evaluate(async ({ webContents }, url) => {
              const guest = webContents.getAllWebContents().find((guest) => guest.getURL() === url)
              const frame = guest?.mainFrame.framesInSubtree.find(
                (frame) => frame !== guest.mainFrame
              )
              const value = frame
                ? await frame.executeJavaScript(
                    'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
                  )
                : []
              return Array.isArray(value) && value.every((item) => typeof item === 'number')
                ? value
                : []
            }, url)
          })
          .toEqual([241, 241, 241, 255])
        await capturePluginEvidence(page, testInfo, 'packaged-stl-viewer', app)
      },
      'packaged-stl-process-ownership'
    )
    const xlsxProof = await capturePluginViewerProcessEvidence(
      app,
      testInfo,
      async () => {
        await open('ProducedBudget.xlsx')
        await expect.poll(() => visibleViewerText(page, app)).toContain('Producer-generated budget')
        await capturePluginEvidence(page, testInfo, 'packaged-xlsx-viewer', app)
      },
      'packaged-xlsx-process-ownership'
    )
    for (const processProof of [stlProof, xlsxProof]) {
      const viewers = processProof.contents.filter((contents) => contents.viewer)
      expect(viewers).toHaveLength(1)
      const parserPids = viewers.flatMap((viewer) =>
        viewer.frames.filter((frame) => !frame.top).map((frame) => frame.pid)
      )
      expect(new Set(parserPids).size).toBe(1)
      expect(
        processProof.workerThreads.some(
          (worker) => worker.name === 'DedicatedWorker thread' && parserPids.includes(worker.pid)
        )
      ).toBe(true)
      for (const pid of parserPids) {
        const sample = processProof.processes.find((process) => process.pid === pid)
        expect(sample?.memoryKB).toBeGreaterThan(0)
        expect(sample?.cumulativeCPUSeconds).toBeGreaterThanOrEqual(0)
      }
    }
    await writeFile(workbookPath, 'Malformed workbook')
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await cp(join(corpus, 'ProducedBudget.xlsx'), workbookPath)
    await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => visibleViewerText(page, app)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'packaged-parser-recovery', app)
    await session.close(app)
    launched = null
    launched = await session.launch(launchOptions)
    ;({ page, app } = launched)
    await expect.poll(() => visibleViewerText(page, app)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'packaged-viewer-restart', app)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
