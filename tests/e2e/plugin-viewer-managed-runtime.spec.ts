import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence } from './helpers/plugin-evidence'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActivePanePtyId } from './helpers/terminal'
import { callEnvironment } from './helpers/paired-host-terminal'
import {
  cleanupDockerSshHostTarget,
  copyFileIntoDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget,
  writeDockerSshHostTargetFile,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'

async function viewerValue(
  app: ElectronApplication,
  url: string,
  script = 'document.body?.innerText ?? ""'
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const guest = webContents.getAllWebContents().find((entry) => entry.getURL() === url)
      const frame = guest?.mainFrame.framesInSubtree.find((entry) => entry !== guest.mainFrame)
      return frame?.executeJavaScript(script) ?? null
    },
    { url, script }
  )
}

test('managed server startup opens remote-only format files and reacquires leases through Reload', async ({
  browserName: _browserName
}, testInfo) => {
  const template = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
  test.skip(
    !template || process.env.ORCA_E2E_SSH_DOCKER !== '1',
    'Needs Docker and a source-built server template'
  )
  test.setTimeout(240_000)
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const session = createRestartSession(testInfo, {
    ...fixture.gitEnvironment,
    ORCA_ORCAD_TEMPLATE_PATH: template!
  })
  let target: DockerSshHostTarget | null = null
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    target = startDockerSshHostTarget(testInfo)
    const workbook = posix.join(DOCKER_SSH_HOST_REMOTE_REPO_PATH, 'ManagedBudget.xlsx')
    const model = posix.join(DOCKER_SSH_HOST_REMOTE_REPO_PATH, 'ManagedPyramid.stl')
    const folder = '/tmp/orca-managed-viewer-folder'
    const folderWorkbook = posix.join(folder, 'FolderBudget.xlsx')
    const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
    for (const file of [workbook, model, folderWorkbook]) {
      expect(existsSync(file)).toBe(false)
    }
    execDockerSshHostTargetCommand(target, `mkdir -p ${folder}`)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'ProducedBudget.xlsx'), workbook)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'Pyramid.stl'), model)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'ProducedBudget.xlsx'), folderWorkbook)
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
      const review = page.getByRole('dialog', { name: 'Review plugin', exact: true })
      await expect(review).toContainText('can read only the file you open with it')
      await review.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await expect(review).toBeHidden()
    }
    await page.keyboard.press('Escape')
    const connection = await page.evaluate(
      async (input) => {
        const { target } = await window.api.ssh.addTarget({ target: input })
        const state = await window.api.ssh.connect({ targetId: target.id })
        const environment = (await window.api.runtimeEnvironments.list()).find(
          (entry) => entry.orcadDeployment?.sshTargetId === target.id
        )
        if (state?.managedServer?.kind !== 'managed' || !environment) {
          throw new Error(`Managed startup failed: ${JSON.stringify(state?.managedServer)}`)
        }
        return { targetId: target.id, environmentId: environment.id }
      },
      {
        label: 'Managed document server',
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      }
    )
    const status = await callEnvironment(page, connection.environmentId, 'status.get', {})
    expect(status).toMatchObject({
      capabilities: expect.arrayContaining(['files.plugin-viewer-document.v1'])
    })
    const added = await callEnvironment(page, connection.environmentId, 'repo.add', {
      path: DOCKER_SSH_HOST_REMOTE_REPO_PATH,
      kind: 'git'
    })
    if (
      !added ||
      typeof added !== 'object' ||
      !('repo' in added) ||
      !added.repo ||
      typeof added.repo !== 'object' ||
      !('id' in added.repo) ||
      typeof added.repo.id !== 'string'
    ) {
      throw new Error(`Managed repository unavailable: ${JSON.stringify(added)}`)
    }
    const repoId = added.repo.id
    const findWorktree = () =>
      page.evaluate(
        (repoId) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((entry) => entry.repoId === repoId)?.id ?? null,
        repoId
      )
    await expect.poll(findWorktree, { timeout: 30_000 }).not.toBeNull()
    const worktreeId = await findWorktree()
    if (!worktreeId) {
      throw new Error('Managed worktree did not hydrate')
    }
    await page.evaluate(
      ({ worktreeId, environmentId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId, environmentId: connection.environmentId }
    )
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
    await waitForActivePanePtyId(page, 30_000)
    await openFileExplorer(page)
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    const currentUrl = async (): Promise<string> => {
      await expect(viewer.locator('webview')).toHaveAttribute('src', /^orca-plugin-viewer:\/\//)
      const url = await viewer.locator('webview').getAttribute('src')
      if (!url) {
        throw new Error('Managed viewer did not attach')
      }
      return url
    }
    const open = async (name: string): Promise<string> => {
      const row = page
        .locator('[data-file-explorer-row]')
        .filter({ has: page.getByText(name, { exact: true }) })
      await expect(row).toBeVisible()
      await row.dblclick()
      await expect(viewer).toBeVisible()
      return currentUrl()
    }
    let url = await open('ManagedBudget.xlsx')
    await expect.poll(() => viewerValue(app, url)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-xlsx', app)
    writeDockerSshHostTargetFile(target, workbook, 'invalid workbook')
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-malformed', app)
    copyFileIntoDockerSshHostTarget(target, join(corpus, 'ProducedBudget.xlsx'), workbook)
    await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
    url = await currentUrl()
    await expect.poll(() => viewerValue(app, url)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-repaired', app)
    url = await open('ManagedPyramid.stl')
    const pixel =
      'Array.from(document.querySelector("canvas")?.getContext("2d")?.getImageData(256,256,1,1).data ?? [])'
    await expect.poll(() => viewerValue(app, url, pixel)).toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-stl', app)
    const oldGuests = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((entry) => entry.getURL().startsWith('orca-plugin-viewer://'))
        .map((entry) => entry.id)
    )
    expect(oldGuests).toHaveLength(1)
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, connection.environmentId)
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }, ids) =>
            webContents.getAllWebContents().filter((entry) => ids.includes(entry.id)).length,
          oldGuests
        )
      )
      .toBe(0)
    await expect(viewer.getByRole('alert')).toBeVisible()
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-disconnected', app)
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.connect({ selector })
      await window.__store?.getState().refreshRuntimeEnvironmentStatus(selector)
    }, connection.environmentId)
    expect(
      await app.evaluate(
        ({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((entry) => entry.getURL().startsWith('orca-plugin-viewer://')).length
      )
    ).toBe(0)
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    url = await currentUrl()
    await expect.poll(() => viewerValue(app, url, pixel)).toEqual([241, 241, 241, 255])
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-reconnected', app)
    const group = await callEnvironment(page, connection.environmentId, 'projectGroup.create', {
      name: 'Managed documents',
      parentPath: folder
    })
    if (
      !group ||
      typeof group !== 'object' ||
      !('group' in group) ||
      !group.group ||
      typeof group.group !== 'object' ||
      !('id' in group.group)
    ) {
      throw new Error('Managed folder group unavailable')
    }
    await callEnvironment(page, connection.environmentId, 'folderWorkspace.create', {
      projectGroupId: group.group.id,
      name: 'Managed document folder',
      folderPath: folder
    })
    await page.evaluate(async (runtimeEnvironmentId) => {
      const owner = { runtimeEnvironmentId, throwOnError: true }
      await window.__store?.getState().fetchProjectGroups(owner)
      await window.__store?.getState().fetchFolderWorkspaces(owner)
    }, connection.environmentId)
    await page.getByText('Managed document folder', { exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
    await waitForActivePanePtyId(page, 30_000)
    await openFileExplorer(page)
    url = await open('FolderBudget.xlsx')
    await expect.poll(() => viewerValue(app, url)).toContain('Producer-generated budget')
    await capturePluginEvidence(page, testInfo, 'viewer-managed-runtime-folder', app)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    try {
      if (launched) {
        await session.close(launched.app)
      }
    } finally {
      try {
        await session.dispose()
      } finally {
        if (target) {
          cleanupDockerSshHostTarget(target)
        }
        await rm(fixture.root, { recursive: true, force: true })
      }
    }
  }
})
