import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []

async function createCloneFixture(): Promise<{
  sourcePath: string
  destinationParent: string
}> {
  // Canonicalize macOS /var → /private/var like git does when registering repo.path.
  const rootPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-clone-'))
  )
  tempRoots.push(rootPath)

  const sourcePath = path.join(rootPath, 'default-checkout-source')
  const destinationParent = path.join(rootPath, 'clones')

  mkdirSync(sourcePath, { recursive: true })
  mkdirSync(destinationParent, { recursive: true })
  execFileSync('git', ['init'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: sourcePath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: sourcePath, stdio: 'pipe' })
  writeFileSync(path.join(sourcePath, 'README.md'), '# Default checkout source\n')
  execFileSync('git', ['add', 'README.md'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: sourcePath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: sourcePath, stdio: 'pipe' })

  return { sourcePath, destinationParent }
}

async function createLinkedWorktreeFixture(): Promise<{
  mainPath: string
  siblingPath: string
}> {
  // Canonicalize the main checkout path like git does on macOS /var symlinks.
  const rootPath = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-add-project-linked-'))
  )
  tempRoots.push(rootPath)

  const mainPath = path.join(rootPath, 'linked-source')
  const siblingPath = path.join(rootPath, 'linked-feature')

  mkdirSync(mainPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: mainPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: mainPath, stdio: 'pipe' })
  writeFileSync(path.join(mainPath, 'README.md'), '# Linked source\n')
  execFileSync('git', ['add', 'README.md'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: mainPath, stdio: 'pipe' })
  execFileSync('git', ['worktree', 'add', '-b', 'feature', siblingPath], {
    cwd: mainPath,
    stdio: 'pipe'
  })

  return { mainPath, siblingPath }
}

// Profiles draw a random arm at load; pin it so each test exercises one handoff deterministically.
async function pinWorkspaceDiscoveryArm(page: Page, arm: 'control' | 'treatment'): Promise<void> {
  await page.evaluate(async (assignment) => {
    const state = window.__store?.getState()
    const telemetry = state?.settings?.telemetry
    if (!state || !telemetry) {
      throw new Error('Telemetry settings unavailable')
    }
    await state.updateSettingsOrThrow({
      telemetry: { ...telemetry, workspaceDiscoveryNewUserCohort: assignment }
    })
  }, arm)
}

// A linked checkout may register as its own repo path, so accept any checkout of the fixture.
async function readOpenedProject(page: Page, checkoutPaths: readonly string[]) {
  return page.evaluate((paths) => {
    const state = window.__store?.getState()
    const repo = state?.repos.find((candidate) => paths.includes(candidate.path))
    if (!state || !repo) {
      return null
    }
    const worktrees = state.worktreesByRepo[repo.id] ?? []
    return {
      activePath: worktrees.find((worktree) => worktree.id === state.activeWorktreeId)?.path,
      repoVisibility: repo.externalWorktreeVisibility,
      visibleBranches: worktrees.map((worktree) => worktree.branch).sort()
    }
  }, checkoutPaths)
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.describe('Add project default checkout', () => {
  test('clones a repo and opens the default checkout without the setup-choice modal', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = await createCloneFixture()

    await openSidebarProjectDialog(orcaPage)
    const addDialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(addDialog).toBeVisible()
    await addDialog.getByRole('button', { name: /Clone from URL/i }).click()

    const cloneDialog = orcaPage.getByRole('dialog', { name: /Clone from URL/i })
    await expect(cloneDialog).toBeVisible()
    await cloneDialog.getByPlaceholder('https://github.com/user/repo.git').fill(fixture.sourcePath)
    await cloneDialog.getByPlaceholder('/path/to/destination').fill(fixture.destinationParent)
    await cloneDialog.getByRole('button', { name: /^Clone$/ }).click()

    await expect(orcaPage.getByRole('dialog', { name: /Repo added/i })).toBeHidden()
    await expect(orcaPage.getByText('Use existing worktrees')).toBeHidden()
    await expect(orcaPage.getByText('Create a new worktree')).toBeHidden()

    await expect
      .poll(
        () =>
          orcaPage.evaluate((cloneName) => {
            const state = window.__store?.getState()
            if (!state) {
              return null
            }
            const repo = state.repos.find((candidate) => candidate.displayName === cloneName)
            if (!repo) {
              return null
            }
            const worktrees = state.worktreesByRepo[repo.id] ?? []
            const defaultCheckout = worktrees.find((worktree) => worktree.isMainWorktree)
            const normalizedDefaultCheckoutPath = defaultCheckout?.path.replace(/\\/g, '/') ?? null
            return {
              activeCheckoutIsDefault: state.activeWorktreeId === defaultCheckout?.id,
              defaultCheckoutLooksCloned:
                normalizedDefaultCheckoutPath?.endsWith(`/clones/${cloneName}`) ?? false,
              oldSetupModalOpen: state.activeModal === 'project-added'
            }
          }, path.basename(fixture.sourcePath)),
        {
          timeout: 30_000,
          message: 'cloned repo default checkout was not opened'
        }
      )
      .toEqual({
        activeCheckoutIsDefault: true,
        defaultCheckoutLooksCloned: true,
        oldSetupModalOpen: false
      })
  })

  for (const arm of ['control', 'treatment'] as const) {
    test(`${arm} handoff ${arm === 'control' ? 'reveals' : 'suggests'} sibling git worktrees`, async ({
      orcaPage
    }) => {
      await waitForSessionReady(orcaPage)
      await pinWorkspaceDiscoveryArm(orcaPage, arm)
      const fixture = await createLinkedWorktreeFixture()

      await orcaPage.evaluate((folderPath) => {
        window.__store?.getState().openModal('confirm-add-project-from-folder', { folderPath })
      }, fixture.mainPath)
      const addProjectDialog = orcaPage.getByRole('dialog', { name: /^Add Project$/i })
      await expect(addProjectDialog).toBeVisible()
      await addProjectDialog.getByRole('button', { name: /^Add Project$/ }).click()

      await expect(addProjectDialog).toBeHidden()
      await expect(orcaPage.getByRole('dialog', { name: /Repo added/i })).toBeHidden()
      await expect(orcaPage.getByText('Use existing worktrees')).toBeHidden()

      await expect
        .poll(() => readOpenedProject(orcaPage, [fixture.mainPath, fixture.siblingPath]), {
          timeout: 30_000,
          message: `${arm} handoff did not open the default checkout as expected`
        })
        .toEqual(
          arm === 'control'
            ? {
                activePath: fixture.mainPath,
                repoVisibility: 'show',
                visibleBranches: ['refs/heads/feature', 'refs/heads/main']
              }
            : {
                activePath: fixture.mainPath,
                repoVisibility: undefined,
                visibleBranches: ['refs/heads/main']
              }
        )
      const review = orcaPage
        .locator('[data-worktree-sidebar]')
        .getByRole('button', { name: /^Review hidden workspaces for/ })
      await expect(review).toHaveCount(arm === 'control' ? 0 : 1)
    })
  }

  test('opens the linked checkout picked in the folder dialog', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await pinWorkspaceDiscoveryArm(orcaPage, 'treatment')
    const fixture = await createLinkedWorktreeFixture()
    await electronApp.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
        bookmarks: []
      })
    }, fixture.siblingPath)

    await openSidebarProjectDialog(orcaPage)
    const addDialog = orcaPage.getByRole('dialog', { name: /Add a project/i })
    await expect(addDialog).toBeVisible()
    await addDialog.getByRole('button', { name: /Browse folder/i }).click()
    const confirmDialog = orcaPage.getByRole('dialog', { name: /^Add Project$/i })
    const needsConfirmation = await confirmDialog
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
    if (needsConfirmation) {
      await confirmDialog.getByRole('button', { name: /^Add Project$/ }).click()
    }

    await expect
      .poll(() => readOpenedProject(orcaPage, [fixture.mainPath, fixture.siblingPath]), {
        timeout: 30_000,
        message: 'the picked linked checkout was not opened'
      })
      .toEqual({
        activePath: fixture.siblingPath,
        repoVisibility: undefined,
        visibleBranches: ['refs/heads/feature']
      })
  })
})
