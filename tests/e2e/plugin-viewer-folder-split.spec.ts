import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'
import { capturePluginViewerProcessEvidence } from './helpers/plugin-viewer-process-evidence'

async function nativeViewers(app: ElectronApplication) {
  return app.evaluate(async ({ webContents }) =>
    Promise.all(
      webContents
        .getAllWebContents()
        .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://'))
        .map(async (guest) => {
          const frame = guest.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
          const text = frame ? await frame.executeJavaScript('document.body.innerText') : ''
          return {
            id: guest.id,
            url: guest.getURL(),
            text: typeof text === 'string' ? text : ''
          }
        })
    )
  )
}

test('folder viewers own separate split leases and preserve each pane through hiding, reload and restart', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(120_000)
  const fixture = await createPluginCatalogFixture({ viewerPack: true })
  const directory = join(fixture.root, 'Documents')
  await mkdir(directory)
  const folderPath = await realpath(directory)
  const filePath = join(folderPath, 'notes.viewer-fixture')
  const document = (prefix: string): string =>
    Array.from({ length: 200 }, (_, index) => `${prefix} line ${index + 1}`).join('\n')
  await writeFile(filePath, document('Original document'))
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    let page = launched.page
    const workspaceId = await page.evaluate(async (folderPath) => {
      const state = window.__store!.getState()
      const group = await window.api.projectGroups.create({
        name: 'Documents',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      if (!group) {
        throw new Error('Folder group unavailable')
      }
      await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const folder = await state.createFolderWorkspace(
        { projectGroupId: group.id, name: 'Viewer documents', folderPath },
        { runtimeEnvironmentId: null }
      )
      if (!folder) {
        throw new Error('Folder workspace unavailable')
      }
      window.__store!.getState().setActiveFolderWorkspace(folder.id, 'local')
      return `folder:${folder.id}`
    }, folderPath)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page.getByRole('combobox', { name: 'Plugin type' }).click()
    await page.getByRole('option', { name: 'File viewers' }).click()
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
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
    await page.getByText('Viewer documents', { exact: true }).click()
    await openFileExplorer(page)
    await page
      .locator('[data-file-explorer-row]')
      .filter({ has: page.getByText('notes.viewer-fixture', { exact: true }) })
      .dblclick()
    await expect
      .poll(() => nativeViewers(launched!.app))
      .toEqual([
        expect.objectContaining({ text: expect.stringContaining('Original document line 1') })
      ])
    const split = await page.evaluate(
      ({ workspaceId, filePath }) => {
        const state = window.__store!.getState()
        const left = state.ensureWorktreeRootGroup(workspaceId)
        const right = state.createEmptySplitGroup(workspaceId, left, 'right')
        if (!right) {
          throw new Error('Viewer split unavailable')
        }
        const fileId = state.openFile(
          {
            filePath,
            relativePath: 'notes.viewer-fixture',
            worktreeId: workspaceId,
            runtimeEnvironmentId: null,
            mode: 'edit',
            language: 'plaintext'
          },
          { preview: false, targetGroupId: right }
        )
        const rightTab = window
          .__store!.getState()
          .findTabForEntityInGroup(workspaceId, right, fileId, 'editor')
        if (!rightTab) {
          throw new Error('Split tab unavailable')
        }
        return { left, right, rightTabId: rightTab.id }
      },
      { workspaceId, filePath }
    )
    const leftPane = (): ReturnType<typeof page.locator> =>
      page.locator(`[data-tab-group-body-id="${split.left}"]`)
    const rightPane = (): ReturnType<typeof page.locator> =>
      page.locator(`[data-tab-group-body-id="${split.right}"]`)
    await expect(page.locator('[data-plugin-file-viewer]')).toHaveCount(2)
    await expect.poll(async () => (await nativeViewers(launched!.app)).length).toBe(2)
    const rightUrl = await rightPane().locator('webview').getAttribute('src')
    await expect
      .poll(
        async () => (await nativeViewers(launched!.app)).find((item) => item.url === rightUrl)?.text
      )
      .toContain('Original document line 1')
    await capturePluginViewerProcessEvidence(launched.app, testInfo, async () => {
      await launched!.app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
        const frame = guest?.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
        await frame?.executeJavaScript(
          `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Next')?.click()`
        )
      }, rightUrl)
      await expect
        .poll(
          async () =>
            (await nativeViewers(launched!.app)).find((item) => item.url === rightUrl)?.text
        )
        .toContain('Original document line 65')
    })
    await capturePluginEvidence(page, testInfo, 'viewer-folder-split', launched.app)
    await rightPane().getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Orca viewer' }).click()
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(rightPane().locator('.monaco-editor .view-lines')).toContainText(
      'Original document line 1'
    )
    await expect(leftPane().locator('[data-plugin-file-viewer]')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-folder-split-source', launched.app)
    await page.evaluate(
      ({ workspaceId, rightTabId }) => {
        window.__store!.getState().activateTab(rightTabId, { worktreeId: workspaceId })
      },
      { workspaceId, rightTabId: split.rightTabId }
    )
    await expect(rightPane().locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect
      .poll(
        async () =>
          (await nativeViewers(launched!.app)).filter((item) =>
            item.text.includes('Original document line 65')
          ).length
      )
      .toBe(1)
    await writeFile(filePath, document('Updated document'))
    await leftPane().getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await nativeViewers(launched!.app)).filter((item) =>
            item.text.includes('Updated document line 1')
          ).length
      )
      .toBe(1)
    await expect
      .poll(
        async () =>
          (await nativeViewers(launched!.app)).filter((item) =>
            item.text.includes('Original document line 65')
          ).length
      )
      .toBe(1)
    await capturePluginEvidence(page, testInfo, 'viewer-folder-split-reload', launched.app)
    await session.close(launched.app)
    launched = await session.launch()
    page = launched.page
    await expect(page.locator('[data-plugin-file-viewer]')).toHaveCount(2)
    await expect
      .poll(async () => (await nativeViewers(launched!.app)).map((item) => item.text).sort())
      .toEqual([
        expect.stringContaining('Updated document line 1'),
        expect.stringContaining('Updated document line 65')
      ])
    await capturePluginEvidence(page, testInfo, 'viewer-folder-split-restart', launched.app)
    await page
      .locator(`[data-tab-group-strip-id="${split.right}"] [data-tab-id]`)
      .filter({ hasText: 'notes.viewer-fixture' })
      .first()
      .getByRole('button', { name: /^Close tab/ })
      .click()
    await expect.poll(async () => (await nativeViewers(launched!.app)).length).toBe(1)
    await expect(leftPane().locator('[data-plugin-file-viewer]')).toBeVisible()
    await expect(rightPane().locator('.monaco-editor .view-lines')).toContainText(
      'Updated document line 1'
    )
    await capturePluginEvidence(page, testInfo, 'viewer-folder-split-close', launched.app)
    expect(await page.evaluate(() => window.__store!.getState().repos.length)).toBe(0)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
