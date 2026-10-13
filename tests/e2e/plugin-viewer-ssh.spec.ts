import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'
import { openNamedPluginViewerFile } from './helpers/plugin-viewer-named-file'
import {
  startDockerSshHostTarget,
  cleanupDockerSshHostTarget,
  copyFileIntoDockerSshHostTarget,
  execDockerSshHostTargetCommand,
  writeDockerSshHostTargetFile,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  connectDockerSshHostTarget,
  disconnectDockerSshHostTarget,
  reconnectDisconnectedDockerSshHostTarget
} from './helpers/docker-ssh-relay-connection'

async function viewerText(app: ElectronApplication, url?: string): Promise<string> {
  return app.evaluate(async ({ webContents }, url) => {
    const text = await Promise.all(
      webContents
        .getAllWebContents()
        .filter((guest) =>
          url ? guest.getURL() === url : guest.getURL().startsWith('orca-plugin-viewer://')
        )
        .map(async (guest) => {
          const frame = guest.mainFrame.framesInSubtree.find((frame) => frame !== guest.mainFrame)
          return frame ? frame.executeJavaScript('document.body.innerText') : ''
        })
    )
    return text.join('\n')
  }, url)
}

async function viewerCenterPixel(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(async ({ webContents }) => {
    for (const guest of webContents
      .getAllWebContents()
      .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://'))) {
      const frame = guest.mainFrame.framesInSubtree.find((frame) => frame !== guest.mainFrame)
      if (frame) {
        const pixels = await frame.executeJavaScript(
          'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
        )
        if (
          Array.isArray(pixels) &&
          pixels.every((value) => typeof value === 'number') &&
          pixels.length === 4
        ) {
          return pixels
        }
      }
    }
    return []
  })
}

test('opens real SSH-only binary files, repairs a failed viewer and retires old leases through reconnect', async ({
  browserName: _browserName
}, testInfo) => {
  test.skip(
    process.env.ORCA_E2E_SSH_DOCKER !== '1',
    'Set ORCA_E2E_SSH_DOCKER=1 for the actual OpenSSH integration'
  )
  test.setTimeout(240_000)
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  let target: DockerSshHostTarget | null = null
  try {
    target = startDockerSshHostTarget(testInfo)
    const workbookPath = posix.join(DOCKER_SSH_HOST_REMOTE_REPO_PATH, 'SSHOnlyBudget.xlsx')
    const modelPath = posix.join(DOCKER_SSH_HOST_REMOTE_REPO_PATH, 'SSHOnlyPyramid.stl')
    const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
    const localWorkbook = join(corpus, 'ProducedBudget.xlsx')
    expect(existsSync(workbookPath)).toBe(false)
    expect(existsSync(modelPath)).toBe(false)
    copyFileIntoDockerSshHostTarget(target, localWorkbook, workbookPath)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'Pyramid.stl'), modelPath)
    launched = await session.launch()
    const { page, app } = launched
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const enabled = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await enabled.isChecked())) {
      await enabled.click()
    }
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
      const consent = page.getByRole('dialog', { name: 'Review plugin', exact: true })
      await expect(consent).toContainText('can read only the file you open with it')
      await consent.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(consent).toBeHidden()
      await page.getByRole('tab', { name: /^Installed/ }).click()
      await expect(
        page.locator(`[data-plugin-key="stablyai.orca-viewer-${format.id}"]`)
      ).toContainText('Enabled')
    }
    await page.keyboard.press('Escape')
    const remote = await connectDockerSshHostTarget(page, target, { seedInitialTab: false })
    await openFileExplorer(page)
    const open = async (name: string): Promise<void> => {
      const row = page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
      await expect(row).toBeVisible()
      await row.dblclick()
      await expect(page.locator('[data-plugin-file-viewer]:visible')).toBeVisible()
    }
    await open('SSHOnlyBudget.xlsx')
    await expect
      .poll(() => viewerText(app), { timeout: 30_000 })
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-xlsx', app)
    const viewer = page.locator('[data-plugin-file-viewer]')
    writeDockerSshHostTargetFile(target, workbookPath, 'This is not a workbook')
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-malformed', app)
    copyFileIntoDockerSshHostTarget(target, localWorkbook, workbookPath)
    await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect
      .poll(() => viewerText(app), { timeout: 30_000 })
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-repaired', app)
    await open('SSHOnlyPyramid.stl')
    await expect
      .poll(() => viewerCenterPixel(app), { timeout: 30_000 })
      .toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-stl', app)
    const selectedWorkbook = '/tmp/OutsideDirectBudget.xlsx'
    copyFileIntoDockerSshHostTarget(target, localWorkbook, selectedWorkbook)
    expect(existsSync(selectedWorkbook)).toBe(false)
    await openNamedPluginViewerFile(page, selectedWorkbook, async () => {
      await capturePluginEvidence(page, testInfo, 'viewer-ssh-outside-choice', app)
    })
    await expect.poll(() => viewerText(app)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-outside-xlsx', app)
    const originalGeneration = await page.evaluate(
      (targetId) =>
        window.__store?.getState().sshConnectionStates.get(targetId)?.connectionGeneration,
      remote.targetId
    )
    expect(originalGeneration).toEqual(expect.any(Number))
    const guestIds = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((guest) => guest.getURL().startsWith('orca-plugin-viewer://'))
        .map((guest) => guest.id)
    )
    await disconnectDockerSshHostTarget(page, remote.targetId)
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, ids) =>
            ids.filter((id) => webContents.fromId(id) && !webContents.fromId(id)?.isDestroyed()),
          guestIds
        )
      )
      .toEqual([])
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-disconnected', app)
    await reconnectDisconnectedDockerSshHostTarget(page, remote.targetId)
    const reconnectedGeneration = await page.evaluate(
      (targetId) =>
        window.__store?.getState().sshConnectionStates.get(targetId)?.connectionGeneration,
      remote.targetId
    )
    expect(reconnectedGeneration).toEqual(expect.any(Number))
    expect(reconnectedGeneration).not.toBe(originalGeneration)
    expect(await viewerText(app)).toBe('')
    await expect(viewer.getByRole('alert')).toBeVisible()
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect
      .poll(() => viewerText(app), { timeout: 30_000 })
      .toContain('Producer-generated budget')
    expect(
      await page.evaluate(
        (filePath) =>
          window.__store?.getState().openFiles.find((file) => file.filePath === filePath)
            ?.operationProvenance?.expectedSshConnectionGeneration,
        selectedWorkbook
      )
    ).toBe(reconnectedGeneration)
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-reconnected', app)
    const folderPath = '/tmp/orca-viewer-documents'
    const folderWorkbook = posix.join(folderPath, 'FolderBudget.xlsx')
    execDockerSshHostTargetCommand(target, 'mkdir -p /tmp/orca-viewer-documents')
    copyFileIntoDockerSshHostTarget(target, localWorkbook, folderWorkbook)
    expect(existsSync(folderWorkbook)).toBe(false)
    expect(
      execDockerSshHostTargetCommand(target, 'test ! -e /tmp/orca-viewer-documents/.git')
    ).toBe('')
    await page.evaluate(
      async ({ targetId, folderPath }) => {
        const group = await window.api.projectGroups.create({
          name: 'Remote viewer documents',
          parentPath: folderPath,
          connectionId: targetId
        })
        await window.__store!.getState().fetchProjectGroups()
        const folder = await window.__store!.getState().createFolderWorkspace({
          projectGroupId: group.id,
          name: 'Remote viewer folder',
          folderPath,
          connectionId: targetId
        })
        if (!folder) {
          throw new Error('Remote folder workspace unavailable')
        }
        window.__store!.getState().setActiveFolderWorkspace(folder.id, `ssh:${targetId}`)
      },
      { targetId: remote.targetId, folderPath }
    )
    await openFileExplorer(page)
    await open('FolderBudget.xlsx')
    const folderViewer = page.locator('[data-plugin-file-viewer]:visible')
    await expect(folderViewer).toContainText('FolderBudget.xlsx')
    await expect(folderViewer.locator('webview')).toHaveAttribute('src', /^orca-plugin-viewer:\/\//)
    const folderUrl = await folderViewer.locator('webview').getAttribute('src')
    expect(folderUrl).toBeTruthy()
    await expect
      .poll(() => viewerText(app, folderUrl!), { timeout: 30_000 })
      .toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-ssh-folder', app)
    expect(existsSync(workbookPath)).toBe(false)
    expect(existsSync(modelPath)).toBe(false)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    cleanupDockerSshHostTarget(target)
    await rm(fixture.root, { recursive: true, force: true })
  }
})
