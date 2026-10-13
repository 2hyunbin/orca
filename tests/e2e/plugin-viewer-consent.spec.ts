import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'
import { publishViewerFixtureUpdate } from './helpers/plugin-viewer-fixture-release'

async function viewerText(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
    const frame = guest?.mainFrame.framesInSubtree.find(
      (candidate) => candidate !== guest.mainFrame
    )
    const text = frame ? await frame.executeJavaScript('document.body?.innerText ?? ""') : ''
    return typeof text === 'string' ? text : ''
  })
}

test('installs an exact viewer release with a separate opened-file approval and deliberate enablement', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ viewerPack: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  const filePath = join(workspace, 'notes.viewer-fixture')
  await writeFile(
    filePath,
    Array.from({ length: 200 }, (_, index) =>
      index === 1 ? '<img src="https://example.invalid">' : `Document line ${index + 1}`
    ).join('\n')
  )
  await fixture.runGit(workspace, ['init', '--quiet'])
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
    await page.evaluate(() => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openSettingsTarget({ pane: 'plugins', repoId: null })
      state.openSettingsPage()
    })
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'File viewers' }).click()
    const viewer = page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]')
    await expect(viewer).toContainText('Sample file viewer')
    await capture(page, testInfo, 'viewer-catalog-card')
    await viewer.getByRole('button', { name: 'Install', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Sample file viewer', exact: true })
    await expect(preview).toContainText('3 read-only file viewers')
    await expect(preview).toContainText('can read only the file you open with it')
    await expect(preview).not.toContainText('full access to your files')
    await capture(page, testInfo, 'viewer-install-preview')
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(preview).toBeHidden()
    await viewer.getByRole('button', { name: 'Install', exact: true }).click()
    await preview.getByRole('button', { name: 'Install plugin', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
    await expect(consent).toContainText('Viewer')
    await expect(consent.getByText('Viewer', { exact: true })).toHaveAttribute(
      'title',
      'File viewer — isolated parsing code'
    )
    await expect(consent).toContainText('cannot save changes or access the network')
    await expect(consent).not.toContainText('Declarative content — no plugin code')
    await capture(page, testInfo, 'viewer-opened-file-approval')
    await consent.getByRole('button', { name: 'Keep Disabled', exact: true }).click()
    await expect(consent).toBeHidden()
    await page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = page.locator('[data-plugin-key="stablyai.orca-viewer-sample"]')
    await expect(installed).toContainText('Disabled')
    await installed.getByRole('switch').click()
    await expect(installed).toContainText('Needs review')
    await installed.getByRole('button', { name: 'Review & enable', exact: true }).click()
    await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await expect(consent).toBeHidden()
    await expect(installed).toContainText('Enabled')
    await capture(page, testInfo, 'viewer-approved-package')
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile(
          {
            filePath,
            relativePath: 'notes.viewer-fixture',
            worktreeId,
            language: 'plaintext',
            mode: 'edit'
          },
          { fileViewer: 'core' }
        )
      },
      { filePath, worktreeId }
    )
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Sample file' }).click()
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    const surface = page.locator('[data-plugin-file-viewer]')
    await expect(surface).toBeVisible()
    await expect(surface.getByText('Read only', { exact: true })).toBeVisible()
    await expect.poll(() => viewerText(launched!.app)).toContain('Document line 1')
    await expect
      .poll(() => viewerText(launched!.app))
      .toContain('<img src="https://example.invalid">')
    await capture(page, testInfo, 'viewer-normal-file-tab', launched.app)
    await launched.app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
      const frame = guest?.mainFrame.framesInSubtree.find(
        (candidate) => candidate !== guest.mainFrame
      )
      await frame?.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Next')?.click()`
      )
    })
    await expect.poll(() => viewerText(launched!.app)).toContain('Document line 65')
    await capture(page, testInfo, 'viewer-virtual-scroll', launched.app)
    await session.close(launched.app)
    launched = await session.launch()
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect.poll(() => viewerText(launched!.app)).toContain('Document line 65')
    await capture(launched.page, testInfo, 'viewer-restored-file-tab', launched.app)
    await writeFile(filePath, 'Updated saved file\nSecond line')
    await launched.page.getByRole('button', { name: 'Reload viewer' }).click()
    await expect.poll(() => viewerText(launched!.app)).toContain('Updated saved file')
    await capture(launched.page, testInfo, 'viewer-reloaded-file-tab', launched.app)
    const openBinary = async (filename: string, value: object, name: string): Promise<void> => {
      const filePath = join(workspace, filename)
      await writeFile(
        filePath,
        Buffer.concat([Buffer.from([42]), Buffer.from(JSON.stringify(value))])
      )
      await launched!.page.evaluate(
        ({ filePath, worktreeId, filename }) => {
          window.__store?.getState().openFile(
            {
              filePath,
              relativePath: filename,
              worktreeId,
              language: 'plaintext',
              mode: 'edit'
            },
            { fileViewer: 'core' }
          )
        },
        { filePath, worktreeId, filename }
      )
      await launched!.page.getByRole('button', { name: 'Open with', exact: true }).click()
      await launched!.page.getByRole('option').filter({ hasText: name }).click()
      await launched!.page.getByRole('button', { name: 'Open once', exact: true }).click()
    }
    const inViewer = async (script: string): Promise<unknown> =>
      launched!.app.evaluate(async ({ webContents }, script) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith('orca-plugin-viewer://'))
        const frame = guest?.mainFrame.framesInSubtree.find(
          (candidate) => candidate !== guest.mainFrame
        )
        return frame ? await frame.executeJavaScript(script) : null
      }, script)
    await openBinary(
      'budget.table-fixture',
      { title: '<img src="https://example.invalid">' },
      'Sample table'
    )
    await expect.poll(() => viewerText(launched!.app)).toContain('first:1:2')
    await expect.poll(() => inViewer('document.querySelectorAll("img").length')).toBe(0)
    await capture(launched.page, testInfo, 'viewer-normal-table-tab', launched.app)
    await inViewer('document.querySelector("[role=combobox]").click()')
    await expect.poll(() => viewerText(launched!.app)).toContain('Second sheet')
    await inViewer(
      `Array.from(document.querySelectorAll('[role=option]')).find(item => item.textContent === 'Second sheet').click()`
    )
    await expect.poll(() => viewerText(launched!.app)).toContain('second:1:2')
    await capture(launched.page, testInfo, 'viewer-table-sheet-change', launched.app)
    await openBinary('shape.canvas-fixture', { color: [64, 150, 180] }, 'Sample canvas')
    await expect.poll(() => viewerText(launched!.app)).toContain('100%')
    const pixel =
      'Array.from(document.querySelector("canvas").getContext("2d").getImageData(440,256,1,1).data)'
    await expect.poll(() => inViewer(pixel)).toEqual([0, 0, 0, 0])
    await capture(launched.page, testInfo, 'viewer-normal-canvas-tab', launched.app)
    await inViewer(`document.querySelector('[aria-label="Zoom in"]').click()`)
    await expect.poll(() => viewerText(launched!.app)).toContain('125%')
    await expect.poll(() => inViewer(pixel)).toEqual([64, 150, 180, 255])
    const center = await launched.page
      .locator('[data-plugin-file-viewer] webview')
      .evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + (bounds.height + 40) / 2)
        }
      })
    await expect
      .poll(() =>
        launched!.app.evaluate(async ({ BrowserWindow }, center) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) {
            return null
          }
          const image = await window.webContents.capturePage()
          const size = image.getSize()
          const bitmap = image.toBitmap({ scaleFactor: 1 })
          if (bitmap.byteLength !== size.width * size.height * 4) {
            return null
          }
          const offset = (center.y * size.width + center.x) * 4
          return Array.from(bitmap.subarray(offset, offset + 4)).sort((a, b) => a - b)
        }, center)
      )
      .toEqual([64, 150, 180, 255])
    const canvasLayout = JSON.stringify({
      host: await launched.page
        .locator('[data-plugin-file-viewer] webview')
        .evaluate((element) => ({
          width: element.clientWidth,
          height: element.clientHeight
        })),
      child: await inViewer(
        '({width:innerWidth,height:innerHeight,canvas:document.querySelector("canvas").getBoundingClientRect().toJSON()})'
      )
    })
    await writeFile(
      join(process.cwd(), '.tmp', 'phase-o-1', 'evidence', 'viewer-canvas-layout.json'),
      canvasLayout
    )
    await testInfo.attach('viewer-canvas-layout', {
      contentType: 'application/json',
      body: canvasLayout
    })
    await capture(launched.page, testInfo, 'viewer-canvas-zoom', launched.app)
    await publishViewerFixtureUpdate(fixture)
    await launched.page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    await launched.page.getByRole('tab', { name: /^All/ }).click()
    await launched.page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const updateListing = launched.page.locator(
      '[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]'
    )
    await expect(updateListing).toContainText('1.1.0')
    await updateListing.getByRole('button', { name: 'Check for update', exact: true }).click()
    const updateReview = launched.page.getByRole('dialog', {
      name: 'Sample file viewer',
      exact: true
    })
    await expect(updateReview).toContainText('Your installed version (1.0.0) stays available')
    await expect.poll(() => viewerText(launched!.app)).toContain('125%')
    await capture(launched.page, testInfo, 'viewer-update-review')
    await updateReview.getByRole('button', { name: 'Keep current version', exact: true }).click()
    await launched.page.keyboard.press('Escape')
    await expect.poll(() => viewerText(launched!.app)).toContain('125%')
    await expect(launched.page.locator('[data-plugin-file-viewer] webview')).toBeVisible()
    await capture(launched.page, testInfo, 'viewer-update-declined', launched.app)
    await launched.page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    await launched.page.getByRole('tab', { name: /^All/ }).click()
    await updateListing.getByRole('button', { name: 'Check for update', exact: true }).click()
    await updateReview.getByRole('button', { name: 'Approve and update', exact: true }).click()
    await expect(updateReview).toBeHidden()
    await launched.page.getByRole('tab', { name: /^Installed/ }).click()
    await expect(
      launched.page.locator('[data-plugin-key="stablyai.orca-viewer-sample"]')
    ).toContainText('1.1.0')
    await expect(
      launched.page.locator('[data-plugin-key="stablyai.orca-viewer-sample"]')
    ).toContainText('Enabled')
    await expect(
      launched.page.getByRole('dialog', { name: 'Review plugin', exact: true })
    ).toHaveCount(0)
    await capture(launched.page, testInfo, 'viewer-update-approved')
    await launched.page.keyboard.press('Escape')
    await expect(
      launched.page.locator('[data-plugin-file-viewer]').getByRole('alert')
    ).toBeVisible()
    await launched.page
      .locator('[data-plugin-file-viewer]')
      .getByRole('button', { name: 'Retry', exact: true })
      .click()
    await expect.poll(() => viewerText(launched!.app)).toContain('125%')
    await capture(launched.page, testInfo, 'viewer-update-reloaded', launched.app)
    await launched.page.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile(
          {
            filePath,
            relativePath: 'notes.viewer-fixture',
            worktreeId,
            language: 'plaintext',
            mode: 'edit'
          },
          { fileViewer: 'core' }
        )
      },
      { filePath, worktreeId }
    )
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await launched.page.getByRole('option').filter({ hasText: 'Sample file' }).click()
    await launched.page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect.poll(() => viewerText(launched!.app)).toContain('Updated viewer')
    await expect.poll(() => viewerText(launched!.app)).toContain('Updated saved file')
    await capture(launched.page, testInfo, 'viewer-updated-parser', launched.app)
    await launched.page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    await launched.page.getByRole('tab', { name: /^Installed/ }).click()
    await launched.page
      .locator('[data-plugin-key="stablyai.orca-viewer-sample"]')
      .getByRole('switch')
      .click()
    await launched.page.keyboard.press('Escape')
    await expect(
      launched.page.locator('[data-plugin-file-viewer]').getByRole('alert')
    ).toContainText('This viewer is unavailable.')
    await capture(launched.page, testInfo, 'viewer-disabled-open-tab', launched.app)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
