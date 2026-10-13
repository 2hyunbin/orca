import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  chooseNamedPluginViewerFile,
  openNamedPluginViewerFile
} from './helpers/plugin-viewer-named-file'

async function viewerValue(
  app: ElectronApplication,
  script: string,
  url?: string
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { script, url }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) =>
          url ? contents.getURL() === url : contents.getURL().startsWith('orca-plugin-viewer://')
        )
      const frame = guest?.mainFrame.framesInSubtree.find(
        (candidate) => candidate !== guest.mainFrame
      )
      return frame ? frame.executeJavaScript(script) : null
    },
    { script, url }
  )
}

test('catalog-installed format viewers use a paired headless host and require Reload after disconnect', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(180_000)
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const workspace = join(fixture.root, 'runtime-documents')
  await mkdir(workspace)
  const root = await realpath(workspace)
  const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
  await cp(corpus, root, { recursive: true })
  await fixture.runGit(root, ['init', '--quiet'])
  await fixture.runGit(root, ['add', '--all'])
  await fixture.runGit(root, ['commit', '--quiet', '-m', 'Runtime viewer fixture'])
  let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    host = await launchHeadlessPairedRuntimeHost()
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: root,
      kind: 'git'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Viewer server', {
      extraEnv: fixture.gitEnvironment
    })
    const { page, app, environmentId } = client
    const initialWorktree = () =>
      page.evaluate(
        (repoId) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((row) => row.repoId === repoId)?.id ?? null,
        added.result.repo.id
      )
    await expect.poll(initialWorktree, { timeout: 30_000 }).not.toBeNull()
    const initialWorktreeId = await initialWorktree()
    if (!initialWorktreeId) {
      throw new Error('Paired host worktree is unavailable')
    }
    await page.evaluate(
      ({ worktreeId, environmentId }) =>
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`),
      { worktreeId: initialWorktreeId, environmentId }
    )
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
    const recoveryWorkbook = join(fixture.root, 'UninstalledViewerBudget.xlsx')
    await cp(join(corpus, 'ProducedBudget.xlsx'), recoveryWorkbook)
    await chooseNamedPluginViewerFile(page, recoveryWorkbook)
    const opening = page.locator('[data-file-opening]:visible')
    await expect(opening).toContainText('No installed viewer matches this file.')
    await expect(opening.getByRole('button', { name: 'Use Orca once' })).toHaveCount(0)
    const recoveryTab = await page.evaluate((filePath) => {
      const state = window.__store?.getState()
      const file = state?.openFiles.find((file) => file.filePath === filePath)
      const tab =
        file &&
        state?.unifiedTabsByWorktree[file.worktreeId]?.find((tab) => tab.entityId === file.id)
      return file && tab
        ? { id: tab.id, groupId: tab.groupId, owner: file.runtimeEnvironmentId }
        : null
    }, recoveryWorkbook)
    if (!recoveryTab) {
      throw new Error('Selected file has no source tab')
    }
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-no-installed-viewer', app)
    await opening.getByRole('button', { name: 'Browse file viewers', exact: true }).click()
    const enabled = page.getByRole('switch', { name: 'Plugin system' })
    await expect(enabled).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-catalog-feature-off', app)
    if (!(await enabled.isChecked())) {
      await enabled.click()
    }
    await expect(page.getByRole('combobox', { name: 'Plugin type' })).toContainText('File viewers')
    await expect(
      page.locator('[data-marketplace-plugin-key="stablyai.orca-portuguese"]')
    ).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-catalog-recovery', app)
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
    await page.keyboard.press('Escape')
    await expect(opening).toContainText('Choose a viewer to open this file.')
    await opening.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'XLSX tables' }).click()
    await expect(page.getByRole('option', { name: 'Orca viewer', exact: true })).toHaveCount(0)
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-catalog-installed-choice', app)
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(page.locator('[data-plugin-file-viewer]:visible')).toBeVisible()
    await expect
      .poll(() => viewerValue(app, 'document.body.innerText'))
      .toContain('Producer-generated budget')
    await expect
      .poll(() =>
        page.evaluate(
          ({ filePath, sourceTab }) => {
            const state = window.__store?.getState()
            const file = state?.openFiles.find(
              (file) => file.filePath === filePath && file.runtimeEnvironmentId === sourceTab.owner
            )
            const tab =
              file &&
              state?.unifiedTabsByWorktree[file.worktreeId]?.find((tab) => tab.id === sourceTab.id)
            return (
              file?.filePath === filePath &&
              file.readOnly === true &&
              file.pluginViewerUserSelectedFile === true &&
              tab?.entityId === file.id &&
              tab.groupId === sourceTab.groupId
            )
          },
          { filePath: recoveryWorkbook, sourceTab: recoveryTab }
        )
      )
      .toBe(true)
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-catalog-returned-file', app)
    await page
      .locator('[data-plugin-file-viewer]:visible')
      .getByRole('button', { name: 'Open with', exact: true })
      .click()
    await page.getByRole('button', { name: 'Browse file viewers', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Plugin type' })).toContainText('File viewers')
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeView))
      .toBe('terminal')
    await expect(page.getByRole('button', { name: 'Back to app', exact: true })).toBeHidden()
    const returnedGuest = page.locator('[data-plugin-file-viewer]:visible webview')
    await expect(returnedGuest).toBeVisible()
    await expect
      .poll(() =>
        returnedGuest.evaluate((element) => {
          const parent = element.parentElement
          return parent ? getComputedStyle(parent).pointerEvents : null
        })
      )
      .toBe('auto')
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-catalog-picker-return', app)
    await openFileExplorer(page)
    const open = async (name: string): Promise<void> => {
      const row = page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
      await expect(row).toBeVisible()
      await row.dblclick()
      await testInfo.attach(`runtime-file-admission-${name}`, {
        contentType: 'application/json',
        body: JSON.stringify(
          await page.evaluate(() => {
            const state = window.__store?.getState()
            return {
              activeView: state?.activeView,
              activeWorktreeId: state?.activeWorktreeId,
              files: state?.openFiles.map((file) => ({
                id: file.id,
                mode: file.mode,
                owner: file.runtimeEnvironmentId,
                viewer: file.pluginViewer?.key
              })),
              environments: state?.runtimeEnvironments.map((environment) => ({
                id: environment.id,
                runtimeId: environment.runtimeId
              }))
            }
          })
        )
      })
      await expect(page.locator('[data-plugin-file-viewer]:visible')).toBeVisible()
    }
    await open('ProducedBudget.xlsx')
    await expect
      .poll(() => viewerValue(app, 'document.body.innerText'), { timeout: 30_000 })
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-xlsx', app)
    await writeFile(join(root, 'ProducedBudget.xlsx'), 'invalid workbook')
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-malformed', app)
    await cp(join(corpus, 'ProducedBudget.xlsx'), join(root, 'ProducedBudget.xlsx'))
    await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect
      .poll(() => viewerValue(app, 'document.body.innerText'))
      .toContain('Producer-generated budget')
    const outsideModel = join(fixture.root, 'OutsidePyramid.stl')
    await cp(join(corpus, 'Pyramid.stl'), outsideModel)
    await openNamedPluginViewerFile(page, outsideModel, async () => {
      await capturePluginEvidence(page, testInfo, 'viewer-runtime-outside-choice', app)
    })
    await expect
      .poll(() =>
        viewerValue(
          app,
          'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
        )
      )
      .toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-outside-stl', app)
    const oldGuests = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://'))
        .map((guest) => guest.id)
    )
    expect(oldGuests).toHaveLength(1)
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, environmentId)
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, ids) =>
            webContents.getAllWebContents().filter((guest) => ids.includes(guest.id)).length,
          oldGuests
        )
      )
      .toBe(0)
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-disconnected', app)
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.connect({ selector })
      await window.__store?.getState().refreshRuntimeEnvironmentStatus(selector)
    }, environmentId)
    expect(
      await app.evaluate(
        ({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://')).length
      )
    ).toBe(0)
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect
      .poll(() =>
        viewerValue(
          app,
          'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
        )
      )
      .toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-explicit-reload', app)
    const folderPath = join(fixture.root, 'runtime-folder')
    await mkdir(folderPath)
    await cp(join(corpus, 'ProducedBudget.xlsx'), join(folderPath, 'FolderBudget.xlsx'))
    const group = await host.client.call<{ group: { id: string } }>('projectGroup.create', {
      name: 'Runtime documents',
      parentPath: folderPath
    })
    await host.client.call('folderWorkspace.create', {
      projectGroupId: group.result.group.id,
      name: 'Runtime folder',
      folderPath
    })
    await page.evaluate(async () => {
      await window.__store?.getState().fetchProjectGroups()
      await window.__store?.getState().fetchFolderWorkspaces()
    })
    await page.getByText('Runtime folder', { exact: true }).click()
    await openFileExplorer(page)
    await open('FolderBudget.xlsx')
    const folderViewer = page.locator('[data-plugin-file-viewer]:visible')
    await expect(folderViewer.locator('webview')).toHaveAttribute('src', /^orca-plugin-viewer:\/\//)
    const folderUrl = await folderViewer.locator('webview').getAttribute('src')
    if (!folderUrl) {
      throw new Error('Runtime folder viewer is unavailable')
    }
    await expect
      .poll(() => viewerValue(app, 'document.body.innerText', folderUrl))
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-folder', app)
    await openNamedPluginViewerFile(page, outsideModel)
    await expect
      .poll(() =>
        viewerValue(
          app,
          'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
        )
      )
      .toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-runtime-folder-outside-stl', app)
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    try {
      await client?.dispose()
    } finally {
      try {
        await host?.dispose()
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  }
})
