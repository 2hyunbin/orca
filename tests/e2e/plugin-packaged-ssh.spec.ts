import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'
import { openNamedPluginViewerFile } from './helpers/plugin-viewer-named-file'
import {
  startDockerSshHostTarget,
  cleanupDockerSshHostTarget,
  copyFileIntoDockerSshHostTarget,
  execDockerSshHostTargetCommand,
  writeDockerSshHostTargetFile,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'

test('the production package opens SSH-only formats in a non-Git folder and reloads selected files after disconnect', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE
  test.skip(
    !executablePath || process.env.ORCA_E2E_SSH_DOCKER !== '1',
    'Provide a production package and actual Docker SSH host'
  )
  test.setTimeout(180_000)
  expect(executablePath && existsSync(executablePath)).toBe(true)
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  let target: DockerSshHostTarget | null = null
  try {
    target = startDockerSshHostTarget(testInfo)
    const folderPath = '/tmp/orca-packaged-viewer-documents'
    const workbookPath = posix.join(folderPath, 'ProductionBudget.xlsx')
    const modelPath = posix.join(folderPath, 'ProductionPyramid.stl')
    const selectedPath = '/tmp/OutsideProductionBudget.xlsx'
    const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
    const workbook = join(corpus, 'ProducedBudget.xlsx')
    execDockerSshHostTargetCommand(target, 'mkdir -p /tmp/orca-packaged-viewer-documents')
    expect(
      execDockerSshHostTargetCommand(target, 'test ! -e /tmp/orca-packaged-viewer-documents/.git')
    ).toBe('')
    copyFileIntoDockerSshHostTarget(target, workbook, workbookPath)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'Pyramid.stl'), modelPath)
    copyFileIntoDockerSshHostTarget(target, workbook, selectedPath)
    for (const path of [workbookPath, modelPath, selectedPath]) {
      expect(existsSync(path)).toBe(false)
    }
    launched = await session.launch({
      executablePath,
      waitForStore: false,
      extraEnv: { NODE_ENV: 'production' }
    })
    const { page, app } = launched
    expect(
      await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        version: app.getVersion(),
        path: app.getAppPath()
      }))
    ).toMatchObject({
      packaged: true,
      version: '1.4.214',
      path: expect.stringContaining('app.asar')
    })
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('switch', { name: 'Plugin system', exact: true }).click()
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
      await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const connection = await page.evaluate(
      async ({ host, port, identityFile, folderPath }) => {
        const unsubscribe = window.api.ssh.onCredentialRequest((request) => {
          void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
        })
        try {
          const { target } = await window.api.ssh.addTarget({
            target: {
              label: 'Production document host',
              host,
              port,
              username: 'root',
              identityFile,
              identitiesOnly: true,
              relayGracePeriodSeconds: 1
            }
          })
          const state = await window.api.ssh.connect({ targetId: target.id })
          if (state?.status !== 'connected') {
            throw new Error('Production SSH connection unavailable')
          }
          const group = await window.api.projectGroups.create({
            name: 'Production SSH documents',
            parentPath: folderPath,
            connectionId: target.id
          })
          await window.api.folderWorkspaces.create({
            projectGroupId: group.id,
            name: 'Production SSH folder',
            folderPath,
            connectionId: target.id
          })
          return { targetId: target.id, generation: state.connectionGeneration }
        } finally {
          unsubscribe()
        }
      },
      { host: target.host, port: target.port, identityFile: target.identityFile, folderPath }
    )
    expect(connection.generation).toEqual(expect.any(Number))
    await page.getByText('Production SSH folder', { exact: true }).click()
    const explorer = page.getByRole('button', { name: /^Explorer/ })
    if (!(await explorer.isVisible())) {
      await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click()
    }
    await explorer.click()
    const open = async (name: string) => {
      await page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
        .dblclick()
      await expect(page.locator('[data-plugin-file-viewer]:visible')).toBeVisible()
    }
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    const value = async (script: string) => {
      const url = await viewer
        .locator('webview')
        .evaluateAll((items) => items[0]?.getAttribute('src') ?? null)
      return app.evaluate(
        async ({ webContents }, { url, script }) => {
          const guest = url && webContents.getAllWebContents().find((item) => item.getURL() === url)
          const frame =
            guest && guest.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
          return frame ? frame.executeJavaScript(script) : null
        },
        { url, script }
      )
    }
    const text = () => value('document.body?.innerText ?? ""')
    await open('ProductionBudget.xlsx')
    await expect.poll(text).toContain('Producer-generated budget')
    await capture(page, testInfo, 'packaged-ssh-folder-xlsx', app)
    writeDockerSshHostTargetFile(target, workbookPath, 'Malformed remote workbook')
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capture(page, testInfo, 'packaged-ssh-malformed', app)
    copyFileIntoDockerSshHostTarget(target, workbook, workbookPath)
    await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(text).toContain('Producer-generated budget')
    await capture(page, testInfo, 'packaged-ssh-repaired', app)
    await open('ProductionPyramid.stl')
    await expect
      .poll(() =>
        value(
          'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
        )
      )
      .toEqual([241, 241, 241, 255])
    await capture(page, testInfo, 'packaged-ssh-folder-stl', app)
    await openNamedPluginViewerFile(page, selectedPath)
    await expect.poll(text).toContain('Producer-generated budget')
    await expect(viewer).toContainText('Read only')
    await capture(page, testInfo, 'packaged-ssh-outside-file', app)
    const guests = () =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((item) => item.getURL().startsWith('orca-plugin-viewer://'))
          .map((item) => item.id)
      )
    expect((await guests()).length).toBeGreaterThan(0)
    await page.evaluate((targetId) => window.api.ssh.disconnect({ targetId }), connection.targetId)
    await expect.poll(guests).toEqual([])
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capture(page, testInfo, 'packaged-ssh-disconnected', app)
    const state = await page.evaluate(
      (targetId) => window.api.ssh.connect({ targetId }),
      connection.targetId
    )
    expect(state?.status).toBe('connected')
    expect(state?.connectionGeneration).toEqual(expect.any(Number))
    expect(state?.connectionGeneration).not.toBe(connection.generation)
    expect(await guests()).toEqual([])
    await expect(viewer.getByRole('alert')).toBeVisible()
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect.poll(text).toContain('Producer-generated budget')
    await capture(page, testInfo, 'packaged-ssh-reconnected', app)
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    for (const path of [workbookPath, modelPath, selectedPath]) {
      expect(existsSync(path)).toBe(false)
    }
  } finally {
    try {
      if (launched) {
        await session.close(launched.app)
      }
    } finally {
      await session.dispose()
      cleanupDockerSshHostTarget(target)
      await rm(fixture.root, { recursive: true, force: true })
    }
  }
})
