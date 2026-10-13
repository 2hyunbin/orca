import { appendFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createPluginCatalogFixture } from './helpers/plugin-catalog-fixture'
import { capturePluginEvidence as capture } from './helpers/plugin-evidence'

async function typeInEditor(page: Page, text: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.getByRole('textbox', { name: 'Editor content', exact: true }).focus()
    await page.keyboard.press('End')
    await page.keyboard.type(text)
  } finally {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await cdp.detach()
  }
}

async function expectReadonlyTyping(page: Page): Promise<void> {
  await typeInEditor(page, 'Q')
  await expect(
    page.getByRole('paragraph').filter({
      hasText: /^Cannot edit in read-only editor$/
    })
  ).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('Q')
}

test('keeps readonly log intent through plugin selection, source return and restart', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await createPluginCatalogFixture({ viewerPack: true })
  const directory = join(fixture.root, 'workspace')
  await mkdir(directory)
  const workspace = await realpath(directory)
  await fixture.runGit(workspace, ['init', '--quiet'])
  const filePath = join(workspace, 'output.viewer-fixture')
  const original = 'Readonly source log\nOriginal last line'
  await writeFile(filePath, original)
  const session = createRestartSession(testInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page } = launched
    const worktreeId = await attachRepoAndOpenTerminal(page, workspace)
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
    const listing = page.locator('[data-marketplace-plugin-key="stablyai.orca-viewer-sample"]')
    await listing.getByRole('button', { name: 'Install', exact: true }).click()
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
    await page.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile(
          {
            filePath,
            relativePath: 'output.viewer-fixture',
            worktreeId,
            language: 'plaintext',
            mode: 'edit',
            readOnly: true,
            liveTail: true
          },
          { preview: false, fileViewer: 'core' }
        )
      },
      { filePath, worktreeId }
    )
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Readonly source log')
    await expectReadonlyTyping(page)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Sample file' }).click()
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Orca viewer' }).click()
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(page.locator('[data-plugin-file-viewer]')).toHaveCount(0)
    await expectReadonlyTyping(page)
    await capture(page, testInfo, 'viewer-readonly-source-return')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Open with', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'Sample file' }).click()
    await page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await session.close(launched.app)
    launched = await session.launch()
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await launched.page.getByRole('option').filter({ hasText: 'Orca viewer' }).click()
    await launched.page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expectReadonlyTyping(launched.page)
    await launched.page.keyboard.press('Escape')
    await appendFile(filePath, '\nLive appended log line')
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText(
      'Live appended log line'
    )
    await expectReadonlyTyping(launched.page)
    await capture(launched.page, testInfo, 'viewer-readonly-source-restart')
    await launched.page.keyboard.press('Escape')
    expect(await readFile(filePath, 'utf8')).toBe(`${original}\nLive appended log line`)

    const editablePath = join(workspace, 'editable.viewer-fixture')
    await writeFile(editablePath, 'Ordinary editable document')
    await launched.page.evaluate(
      ({ filePath, worktreeId }) => {
        window.__store?.getState().openFile(
          {
            filePath,
            relativePath: 'editable.viewer-fixture',
            worktreeId,
            language: 'plaintext',
            mode: 'edit'
          },
          { preview: false, fileViewer: 'core' }
        )
      },
      { filePath: editablePath, worktreeId }
    )
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText(
      'Ordinary editable document'
    )
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await launched.page.getByRole('option').filter({ hasText: 'Sample file' }).click()
    await launched.page.getByRole('button', { name: 'Open once', exact: true }).click()
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    const editableTabs = launched.page.locator('[data-tab-id]').filter({
      hasText: 'editable.viewer-fixture'
    })
    await expect(editableTabs).toHaveCount(2)
    await editableTabs.first().getByRole('button', { name: 'Close tab', exact: true }).click()
    await expect(editableTabs).toHaveCount(1)
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await session.close(launched.app)
    launched = await session.launch()
    await expect(launched.page.locator('[data-plugin-file-viewer]')).toBeVisible()
    await launched.page.getByRole('button', { name: 'Open with', exact: true }).click()
    await launched.page.getByRole('option').filter({ hasText: 'Orca viewer' }).click()
    await launched.page.getByRole('button', { name: 'Open once', exact: true }).click()
    await typeInEditor(launched.page, ' -- editable')
    await expect(launched.page.locator('.monaco-editor .view-lines')).toContainText(
      'Ordinary editable document -- editable'
    )
    await capture(launched.page, testInfo, 'viewer-editable-source-return')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
