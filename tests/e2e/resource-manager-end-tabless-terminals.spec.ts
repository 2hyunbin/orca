import { mkdirSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { makeResourceManagerFixtureVisible } from './helpers/resource-manager-visible-fixture'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'

async function createFolderWorkspace(page: Page, folderPath: string): Promise<string> {
  return page.evaluate(async (folderPath) => {
    const state = window.__store!.getState()
    const group = await window.api.projectGroups.create({
      name: 'Notes',
      parentPath: folderPath,
      createdFrom: 'folder-scan'
    })
    await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    if (!group) {
      throw new Error('Could not create project group')
    }
    const folder = await state.createFolderWorkspace(
      { projectGroupId: group.id, name: 'Notes', folderPath },
      { runtimeEnvironmentId: null }
    )
    if (!folder) {
      throw new Error('Could not create folder workspace')
    }
    return `folder:${folder.id}`
  }, folderPath)
}

async function spawnTablessTerminal(
  page: Page,
  folderPath: string,
  worktreeId: string
): Promise<string> {
  return page.evaluate(
    async ({ folderPath, worktreeId }) => {
      const spawned = await window.api.pty.spawn({
        cols: 80,
        rows: 24,
        cwd: folderPath,
        worktreeId,
        initiallyHidden: true
      })
      return spawned.id
    },
    { folderPath, worktreeId }
  )
}

async function livePtyIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.pty.listSessions({ connectionId: null })).map((session) => session.id)
  )
}

test('Resource Manager ends tab-less terminals from this run and from before a restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const folderPath = testInfo.outputPath('notes')
  mkdirSync(folderPath, { recursive: true })
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const worktreeId = await createFolderWorkspace(launched.page, folderPath)
    const survivorId = await spawnTablessTerminal(launched.page, folderPath, worktreeId)
    await session.close(launched.app)

    launched = await session.launch()
    const page = launched.page
    await waitForSessionReady(page)
    await expect.poll(() => livePtyIds(page)).toContain(survivorId)
    const currentRunId = await spawnTablessTerminal(page, folderPath, worktreeId)
    await page.setViewportSize({ width: 1200, height: 900 })
    await makeResourceManagerFixtureVisible(launched.app, page)
    await page.getByRole('button', { name: /^Resource Manager,/ }).click()
    await page.getByRole('tab', { name: 'PTYs', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: /^PTYs/ })
    await expect(panel.getByText(/2 without a tab/)).toBeVisible()
    const screenshot = testInfo.outputPath('resource-manager-tabless-before-end.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach('tabless-before-end', { path: screenshot, contentType: 'image/png' })

    for (const remaining of [1, 0]) {
      await panel.getByRole('button', { name: /^End / }).first().click()
      await page.getByRole('button', { name: 'End terminal', exact: true }).click()
      await expect(panel).not.toContainText('A client is now attached')
      await expect.poll(async () => (await livePtyIds(page)).length).toBe(remaining)
    }
    const ids = await livePtyIds(page)
    expect(ids).not.toContain(survivorId)
    expect(ids).not.toContain(currentRunId)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
  }
})
