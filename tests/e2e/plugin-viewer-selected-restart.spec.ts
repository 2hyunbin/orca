import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { openNamedPluginViewerFile } from './helpers/plugin-viewer-named-file'
import { nativePluginViewerSnapshot } from './helpers/plugin-viewer-native-snapshot'

test('selected outside files restore their viewer and read-only owner through paired folder restarts', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(180_000)
  const fixture = await createPluginCatalogFixture({ formatViewers: true })
  const directory = join(fixture.root, 'Restart documents')
  await mkdir(directory)
  const folderPath = await realpath(directory)
  const filePath = join(fixture.root, 'SelectedRestartBudget.xlsx')
  const corpus = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'plugin-format-corpus')
  await cp(join(corpus, 'ProducedBudget.xlsx'), filePath)
  let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    host = await launchHeadlessPairedRuntimeHost()
    const group = await host.client.call<{ group: { id: string } }>('projectGroup.create', {
      name: 'Restart documents',
      parentPath: folderPath
    })
    await host.client.call('folderWorkspace.create', {
      projectGroupId: group.result.group.id,
      name: 'Selected-file folder',
      folderPath
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Selected-file server', {
      extraEnv: fixture.gitEnvironment
    })
    let { page } = client
    const environmentId = client.environmentId
    await page.evaluate(async () => {
      await window.__store?.getState().fetchProjectGroups()
      await window.__store?.getState().fetchFolderWorkspaces()
    })
    await page.getByText('Selected-file folder', { exact: true }).click()
    const workspaceId = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
    if (!workspaceId?.startsWith('folder:')) {
      throw new Error('Paired folder unavailable')
    }
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    const feature = page.getByRole('switch', { name: 'Plugin system' })
    if (!(await feature.isChecked())) {
      await feature.click()
    }
    await page
      .locator('[data-marketplace-plugin-key="stablyai.orca-viewer-xlsx"]')
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'XLSX tables', exact: true })
      .getByRole('button', { name: 'Install plugin', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Review plugin', exact: true })
      .getByRole('button', { name: 'Enable plugin', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Review plugin', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeView))
      .toBe('terminal')
    await openNamedPluginViewerFile(page, filePath)
    await expect
      .poll(() => nativePluginViewerSnapshot(client!.app))
      .toEqual([
        expect.objectContaining({ text: expect.stringContaining('Producer-generated budget') })
      ])
    const before = await page.evaluate((filePath) => {
      const state = window.__store?.getState()
      const file = state?.openFiles.find((file) => file.filePath === filePath)
      const tab =
        file &&
        state?.unifiedTabsByWorktree[file.worktreeId]?.find((tab) => tab.entityId === file.id)
      if (!file?.pluginViewer || !tab) {
        throw new Error('Selected viewer tab unavailable')
      }
      return {
        key: file.pluginViewer.key,
        tabId: tab.id,
        groupId: tab.groupId,
        owner: file.runtimeEnvironmentId,
        workspaceId: file.worktreeId
      }
    }, filePath)
    expect(before.owner).toBe(environmentId)
    expect(before.workspaceId).toBe(workspaceId)
    const originalUrl = (await nativePluginViewerSnapshot(client.app))[0]?.url
    expect(originalUrl).toMatch(/^orca-plugin-viewer:\/\//)
    await capture(page, testInfo, 'viewer-selected-runtime-before-restart', client.app)
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettingsOrThrow({
        pluginViewerAssociations: [
          { selector: { kind: 'extension', value: '.xlsx' }, viewerKey: 'core' }
        ]
      })
    })
    const savedFile = () =>
      page.evaluate(
        async ({ workspaceId, filePath, environmentId }) => {
          await window.api.session.flush()
          const saved = await window.api.session.get(`runtime:${environmentId}`)
          return (
            saved.openFilesByWorktree?.[workspaceId]?.find((file) => file.filePath === filePath) ??
            null
          )
        },
        { workspaceId, filePath, environmentId }
      )
    await expect.poll(savedFile).toMatchObject({
      pluginViewerUserSelectedFile: true,
      readOnly: true,
      runtimeEnvironmentId: environmentId,
      pluginViewer: { key: before.key, sourceView: { readOnly: true } }
    })
    const persisted = await savedFile()
    for (const field of [
      'selectionGrantId',
      'operationProvenance',
      'lease',
      'socket',
      'credentials'
    ]) {
      expect(persisted).not.toHaveProperty(field)
    }
    await testInfo.attach('selected-file-persisted-intent', {
      contentType: 'application/json',
      body: JSON.stringify(persisted, null, 2)
    })
    const profile = client.userDataDir
    await client.quitPreservingProfile()
    client = null
    await cp(join(corpus, 'Budget.xlsx'), filePath)
    client = await launchPairedElectronClient(host.offer, testInfo, 'Selected-file server', {
      extraEnv: fixture.gitEnvironment,
      reuseUserDataDir: profile
    })
    page = client.page
    expect(client.environmentId).toBe(environmentId)
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ filePath, before }) => {
              const state = window.__store?.getState()
              const file = state?.openFiles.find((file) => file.filePath === filePath)
              const tab =
                file &&
                state?.unifiedTabsByWorktree[file.worktreeId]?.find(
                  (tab) => tab.id === before.tabId
                )
              return (
                file?.mode === 'plugin-viewer' &&
                file.readOnly === true &&
                file.pluginViewerUserSelectedFile === true &&
                file.pluginViewer?.key === before.key &&
                file.runtimeEnvironmentId === before.owner &&
                tab?.entityId === file.id &&
                tab.groupId === before.groupId
              )
            },
            { filePath, before }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await page.getByText('Selected-file folder', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Back to app', exact: true })).toBeHidden()
    const admission = JSON.stringify(
      await page.evaluate(
        async ({ filePath, environmentId }) => {
          const state = window.__store?.getState()
          const file = state?.openFiles.find((file) => file.filePath === filePath)
          return {
            activeView: state?.activeView,
            activeWorkspaceKey: state?.activeWorkspaceKey,
            activeWorktreeId: state?.activeWorktreeId,
            activeFile: state?.activeFileIdByWorktree,
            file: file && {
              id: file.id,
              mode: file.mode,
              worktreeId: file.worktreeId,
              runtimeEnvironmentId: file.runtimeEnvironmentId,
              selected: file.pluginViewerUserSelectedFile,
              ownerExpired: file.pluginViewerOwnerExpired,
              ownerUnresolved: file.fileOpeningOwnerUnresolved
            },
            folders: state?.folderWorkspaces.map((folder) => ({
              id: folder.id,
              executionHostId: folder.executionHostId
            })),
            runtimeId: state?.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId,
            viewers: await window.api.plugins.listFileViewers?.(),
            plugins: (await window.api.plugins.list()).map((plugin) => ({
              key: plugin.pluginKey,
              status: plugin.status,
              needsReconsent: plugin.needsReconsent
            })),
            visibleText: document.body.innerText
          }
        },
        { filePath, environmentId }
      ),
      null,
      2
    )
    await writeFile(
      join(process.cwd(), '.tmp', 'phase-o-1', 'evidence', 'selected-file-restart-admission.json'),
      admission
    )
    await testInfo.attach('selected-file-restored-admission-state', {
      contentType: 'application/json',
      body: admission
    })
    await capture(page, testInfo, 'viewer-selected-runtime-restored-admission', client.app)
    await expect
      .poll(() => nativePluginViewerSnapshot(client!.app), { timeout: 30_000 })
      .toEqual([expect.objectContaining({ text: expect.stringContaining('Team budget') })])
    const restoredUrl = (await nativePluginViewerSnapshot(client.app))[0]?.url
    expect(restoredUrl).not.toBe(originalUrl)
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await expect(page.getByRole('option', { name: 'Orca viewer', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
    await capture(page, testInfo, 'viewer-selected-runtime-restored-file', client.app)
    const restoredViewer = page.locator('[data-plugin-file-viewer]:visible')
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, environmentId)
    await expect.poll(() => nativePluginViewerSnapshot(client!.app)).toEqual([])
    await expect(restoredViewer.getByRole('alert')).toBeVisible()
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.connect({ selector })
      await window.__store?.getState().refreshRuntimeEnvironmentStatus(selector)
    }, environmentId)
    expect(await nativePluginViewerSnapshot(client.app)).toEqual([])
    await restoredViewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect
      .poll(() => nativePluginViewerSnapshot(client!.app))
      .toEqual([expect.objectContaining({ text: expect.stringContaining('Team budget') })])
    await capture(page, testInfo, 'viewer-selected-runtime-restored-reconnected', client.app)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    await page.getByRole('tab', { name: /^Installed/ }).click()
    const installed = () => page.locator('[data-plugin-key="stablyai.orca-viewer-xlsx"]')
    await installed().getByRole('switch', { name: 'Disable XLSX tables', exact: true }).click()
    await expect(
      installed().getByRole('switch', { name: 'Enable XLSX tables', exact: true })
    ).not.toBeChecked()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await expect.poll(() => nativePluginViewerSnapshot(client!.app)).toEqual([])
    await client.quitPreservingProfile()
    client = null
    client = await launchPairedElectronClient(host.offer, testInfo, 'Selected-file server', {
      extraEnv: fixture.gitEnvironment,
      reuseUserDataDir: profile
    })
    page = client.page
    await page.getByText('Selected-file folder', { exact: true }).click()
    const viewer = page.locator('[data-plugin-file-viewer]:visible')
    await expect(viewer.getByRole('alert')).toContainText('This viewer is unavailable.')
    expect(await nativePluginViewerSnapshot(client.app)).toEqual([])
    await capture(page, testInfo, 'viewer-selected-runtime-restored-disabled', client.app)
    await page.evaluate(() => {
      window.__store?.getState().openSettingsTarget({ pane: 'plugins', repoId: null })
      window.__store?.getState().openSettingsPage()
    })
    await page.getByRole('tab', { name: /^Installed/ }).click()
    await installed().getByRole('switch', { name: 'Enable XLSX tables', exact: true }).click()
    await expect(
      installed().getByRole('switch', { name: 'Disable XLSX tables', exact: true })
    ).toBeChecked()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await viewer.getByRole('button', { name: 'Reload viewer', exact: true }).click()
    await expect
      .poll(() => nativePluginViewerSnapshot(client!.app))
      .toEqual([expect.objectContaining({ text: expect.stringContaining('Team budget') })])
    await capture(page, testInfo, 'viewer-selected-runtime-restored-reenabled', client.app)
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
