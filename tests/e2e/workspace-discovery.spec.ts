import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitExecFileAsync } from '../../src/main/git/runner'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

for (const cohort of ['control', 'treatment'] as const) {
  test(`selectively adds discovered workspaces and remembers dismissal with menu recovery (${cohort})`, async ({
    orcaPage: page,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await page.evaluate(async (assignment) => {
      const state = window.__store?.getState()
      const telemetry = state?.settings?.telemetry
      if (!state || !telemetry) {
        throw new Error('Settings unavailable')
      }
      await state.updateSettingsOrThrow({
        telemetry: { ...telemetry, workspaceDiscoveryCohort: assignment }
      })
    }, cohort)
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-discovery-')))
    const paths = ['discovery-one', 'discovery-two', 'discovery-later'].map((name) =>
      path.join(root, name)
    )
    const created: string[] = []
    registerPostElectronShutdownCleanup(async () => {
      for (const worktreePath of created) {
        await gitExecFileAsync(['worktree', 'remove', '--force', worktreePath], {
          cwd: testRepoPath
        })
      }
      rmSync(root, { recursive: true, force: true })
    })
    for (const worktreePath of paths.slice(0, 2)) {
      await gitExecFileAsync(['worktree', 'add', '--quiet', '--detach', worktreePath], {
        cwd: testRepoPath
      })
      created.push(worktreePath)
    }
    const repoId = await page.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, testRepoPath)
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const store = window.__store
          if (!store) {
            throw new Error('Store unavailable')
          }
          const state = store.getState()
          await state.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          return await store.getState().fetchWorktrees(id, { requireAuthoritative: true })
        }, repoId)
      )
      .toBe(true)
    await page.evaluate((id) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      state.setSidebarOpen(true)
      state.setGroupBy('repo')
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      const primary = state.worktreesByRepo[id]?.find((worktree) => worktree.isMainWorktree)
      if (!primary) {
        throw new Error('Primary workspace missing')
      }
      state.setActiveWorktree(primary.id)
    }, repoId)
    const sidebar = page.locator('[data-worktree-sidebar]')
    const review = sidebar.getByRole('button', { name: /^Review hidden workspaces for/ })
    const manager = page.getByRole('dialog', { name: 'Manage workspaces' })
    const header = sidebar.locator(`[data-repo-header-id=${JSON.stringify(repoId)}]`)
    await expect(header).toBeVisible()
    if (cohort === 'control') {
      await expect(review).toHaveCount(0)
      await page.evaluate(() => window.__store?.getState().setHideDefaultBranchWorkspace(true))
      await expect(header).toBeVisible()
      await header.hover()
      await sidebar.locator('[data-workspace-project-menu]').click()
      await page.getByRole('menuitem', { name: 'Manage workspaces', exact: true }).click()
      await page.evaluate(() => window.__store?.getState().setHideDefaultBranchWorkspace(false))
    } else {
      await expect(review).toBeVisible()
      await expect(sidebar.getByText(paths[0], { exact: true })).toHaveCount(0)
      await review.click()
    }
    await expect(manager).toBeVisible()
    await expect(
      manager.getByRole('button', { name: 'Add to sidebar', exact: true })
    ).toBeDisabled()
    await manager.getByRole('checkbox', { name: /discovery-one/ }).check()
    await manager.getByRole('button', { name: 'Add 1 to sidebar', exact: true }).click()
    await expect(manager.getByRole('checkbox', { name: /discovery-one/ })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('workspace-manager.png') })
    await page.keyboard.press('Escape')
    await expect(manager).toHaveCount(0)
    const firstId = `${repoId}::${paths[0]}`
    await expect(
      sidebar.locator(`[data-worktree-id=${JSON.stringify(firstId)}]`).first()
    ).toBeVisible()
    if (cohort === 'treatment') {
      await sidebar.getByRole('button', { name: /^Hide workspace suggestions for/ }).click()
    }
    await expect(review).toHaveCount(0)
    await page.reload()
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await expect(review).toHaveCount(0)
    await expect(
      sidebar.locator(`[data-worktree-id=${JSON.stringify(firstId)}]`).first()
    ).toBeVisible()

    await gitExecFileAsync(['worktree', 'add', '--quiet', '--detach', paths[2]], {
      cwd: testRepoPath
    })
    created.push(paths[2])
    await page.evaluate(async (id) => {
      if (!window.__store) {
        throw new Error('Store unavailable')
      }
      await window.__store.getState().fetchWorktrees(id, { requireAuthoritative: true })
    }, repoId)
    await expect(review).toHaveCount(0)
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await sidebar.locator(`[data-repo-header-id=${JSON.stringify(repoId)}]`).hover()
    await sidebar.locator('[data-workspace-project-menu]').click()
    await page.getByRole('menuitem', { name: 'Manage workspaces', exact: true }).click()
    await expect(manager).toBeVisible()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(manager.getByRole('checkbox', { name: /discovery-two/ })).toBeVisible()
    await expect(manager.getByRole('checkbox', { name: /discovery-later/ })).toBeVisible()
    await expect(manager.getByRole('checkbox', { name: /discovery-one/ })).toHaveCount(0)
    await expect(
      sidebar.getByRole('button', { name: /^Hide workspace suggestions for/ })
    ).toHaveCount(0)
    await manager.getByRole('button', { name: 'Visibility settings', exact: true }).click()
    await expect(
      manager.getByRole('button', { name: 'Manage in Global Settings', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('workspace-recovery.png') })
    await manager.getByRole('checkbox', { name: /discovery-two/ }).check()
    await manager.getByRole('checkbox', { name: /discovery-later/ }).check()
    await manager.getByRole('button', { name: 'Add 2 to sidebar', exact: true }).click()
    await expect(manager.getByRole('checkbox', { name: /discovery-two/ })).toHaveCount(0)
    await expect(manager.getByRole('checkbox', { name: /discovery-later/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(manager).toHaveCount(0)
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(
      sidebar.locator(`[data-worktree-id=${JSON.stringify(`${repoId}::${paths[1]}`)}]`).first()
    ).toBeVisible()
  })
}
