/**
 * The WSL move fence on a real desktop: a journal written beside the profile, as a move would,
 * must make the moving project refuse new terminals while it stays listed, and once the host owns
 * it, take it out of the project list. Other projects keep working throughout.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { writeWslMoveCutover } from '../../src/main/persistence/moving-wsl-projects/wsl-move-cutover-journal'

test.use({ seedTestRepo: false })

async function createFolders(page: Page, folders: { name: string; folderPath: string }[]) {
  return page.evaluate(async (entries) => {
    const state = window.__store!.getState()
    const ids: string[] = []
    for (const entry of entries) {
      const group = await window.api.projectGroups.create({
        name: entry.name,
        parentPath: entry.folderPath,
        createdFrom: 'folder-scan'
      })
      await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const workspace = group
        ? await state.createFolderWorkspace(
            { projectGroupId: group.id, ...entry },
            { runtimeEnvironmentId: null }
          )
        : null
      if (!workspace) {
        throw new Error(`Could not create folder workspace ${entry.name}`)
      }
      ids.push(workspace.id)
    }
    return ids
  }, folders)
}

/** The spawn's outcome as the renderer sees it: a pty id, or the refusal message. */
async function spawnIn(page: Page, folderWorkspaceId: string, cwd: string): Promise<string> {
  return page.evaluate(
    async ({ id, cwd }) => {
      try {
        const result = await window.api.pty.spawn({
          cols: 80,
          rows: 24,
          cwd,
          worktreeId: `folder:${id}`,
          initiallyHidden: true
        })
        await window.api.pty.kill(result.id)
        return 'spawned'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    { id: folderWorkspaceId, cwd }
  )
}

async function listedFolderIds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await window.api.folderWorkspaces.list()).map((workspace) => workspace.id)
  )
}

test('a WSL move journal fences the moving project, then hides it once the host owns it', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-move-fence-'))
  const folders = ['Moving notes', 'Staying notes'].map((name) => {
    const folderPath = join(root, name)
    mkdirSync(folderPath)
    return { name, folderPath }
  })
  const session = createRestartSession(testInfo)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const [movingId, stayingId] = await createFolders(launched.page, folders)
    await session.close(launched.app)
    launched = undefined

    const record = (phase: 'source-fenced' | 'destination-committed') =>
      wslMoveCutoverFixture('move-1', phase, {}, { repoIds: [], folderWorkspaceIds: [movingId] })
    writeWslMoveCutover(session.userDataDir, record('source-fenced'))
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    expect(await spawnIn(launched.page, movingId, folders[0].folderPath)).toContain(
      'moving to its WSL host'
    )
    expect(await spawnIn(launched.page, stayingId, folders[1].folderPath)).toBe('spawned')
    expect(await listedFolderIds(launched.page)).toEqual(
      expect.arrayContaining([movingId, stayingId])
    )
    await session.close(launched.app)
    launched = undefined

    writeWslMoveCutover(session.userDataDir, record('destination-committed'))
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const listed = await listedFolderIds(launched.page)
    expect(listed).toContain(stayingId)
    expect(listed).not.toContain(movingId)
    expect(await spawnIn(launched.page, movingId, folders[0].folderPath)).toContain(
      'moving to its WSL host'
    )
    expect(await spawnIn(launched.page, stayingId, folders[1].folderPath)).toBe('spawned')
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
