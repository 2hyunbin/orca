import type { Page } from '@stablyai/playwright-test'
import type { HostedReviewCreationEligibility } from '../../src/shared/hosted-review'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

async function seedMissingCreateReview(page: Page, provider: 'github' | 'gitlab') {
  await waitForSessionReady(page)
  return page.evaluate((provider) => {
    const store = window.__store
    if (!store) {
      throw new Error('Test store is unavailable')
    }
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary')
    if (!worktree) {
      throw new Error('Seeded worktree is unavailable')
    }
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const repoId = worktree.repoId
    const hostedKey = `local::${repoId}::${branch}`
    const prKey = `${repoId}::${branch}`
    const initialLookup = Date.now()
    state.setActiveWorktree(worktree.id)
    store.setState((current) => ({
      repos: current.repos.map((repo) =>
        repo.id === repoId
          ? { ...repo, worktreeBaseRef: 'origin/main', gitRemoteIdentity: null }
          : repo
      ),
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repoId]: current.worktreesByRepo[repoId].map((entry) =>
          entry.id === worktree.id
            ? {
                ...entry,
                linkedPR: null,
                linkedGitLabMR: null,
                suppressedGitHubPR: null,
                baseRef: 'origin/main'
              }
            : entry
        )
      },
      gitStatusByWorktree: {
        ...current.gitStatusByWorktree,
        [worktree.id]: Array.from({ length: 7 }, (_, index) => ({
          path: `staged-${index}.ts`,
          status: 'modified' as const,
          area: 'staged' as const
        }))
      },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [worktree.id]: { hasUpstream: true, upstreamName: `origin/${branch}`, ahead: 0, behind: 74 }
      },
      prCache: {
        ...current.prCache,
        [prKey]: { data: null, fetchedAt: initialLookup, lookupRevision: initialLookup }
      },
      hostedReviewCache: {
        ...current.hostedReviewCache,
        [hostedKey]: { data: null, fetchedAt: initialLookup, lookupRevision: initialLookup }
      },
      getHostedReviewCreationEligibility: async (): Promise<HostedReviewCreationEligibility> => {
        const latest = store.getState()
        const hydrated = Boolean(latest.repos.find((repo) => repo.id === repoId)?.gitRemoteIdentity)
        const lookupRefreshed =
          Math.max(
            latest.prCache[prKey]?.lookupRevision ?? 0,
            latest.hostedReviewCache[hostedKey]?.lookupRevision ?? 0
          ) > initialLookup
        const supported = hydrated || lookupRefreshed
        return {
          provider: supported ? provider : 'unsupported',
          review: null,
          canCreate: false,
          blockedReason: supported ? 'dirty' : 'unsupported_provider',
          nextAction: supported ? 'commit' : null,
          defaultBaseRef: 'origin/main',
          head: branch,
          reviewLookupOutcome: 'not_found'
        }
      },
      fetchHostedReviewForBranch: async () => null,
      fetchPRForBranch: async () => null,
      fetchUpstreamStatus: async () => null,
      setUpstreamStatus: () => undefined,
      setGitStatus: () => undefined,
      updateWorktreeGitIdentity: () => undefined
    }))
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarTab('source-control')
    return { repoId, branch, worktreeId: worktree.id, hostedKey, prKey, initialLookup }
  }, provider)
}

for (const provider of ['github', 'gitlab'] as const) {
  test(`restores Create ${provider === 'github' ? 'PR' : 'MR'} after remote hydration without navigating`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const target = await seedMissingCreateReview(orcaPage, provider)
    const action = orcaPage.getByRole('button', {
      name: provider === 'github' ? 'Create PR' : 'Create MR',
      exact: true
    })
    await expect(orcaPage.getByTestId('source-control-filter-toggle')).toBeVisible()
    await expect(action).toHaveCount(0)
    await orcaPage.screenshot({ path: testInfo.outputPath(`create-${provider}-before.png`) })

    await orcaPage.evaluate(
      ({ repoId, provider }) => {
        window.__store?.setState((current) => ({
          repos: current.repos.map((repo) =>
            repo.id === repoId
              ? {
                  ...repo,
                  gitRemoteIdentity: {
                    canonicalKey: `${provider}.com/acme/orca`,
                    remoteName: 'origin',
                    remoteUrl: `git@${provider}.com:acme/orca.git`
                  }
                }
              : repo
          )
        }))
      },
      { repoId: target.repoId, provider }
    )

    await expect(action).toBeVisible()
    await expect(action).toBeEnabled()
    await expect(orcaPage.getByText(target.branch, { exact: true }).last()).toBeVisible()
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    await orcaPage.screenshot({ path: testInfo.outputPath(`create-${provider}-restored.png`) })
  })
}

test('recovers a missing Create PR from the existing GitHub cache refresh', async ({
  orcaPage
}, testInfo) => {
  const target = await seedMissingCreateReview(orcaPage, 'github')
  const action = orcaPage.getByRole('button', { name: 'Create PR', exact: true })
  await expect(orcaPage.getByTestId('source-control-filter-toggle')).toBeVisible()
  await expect(action).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('create-pr-cache-before.png') })

  await orcaPage.evaluate(({ prKey, initialLookup }) => {
    window.__store?.setState((current) => ({
      prCache: {
        ...current.prCache,
        [prKey]: { data: null, fetchedAt: initialLookup, lookupRevision: initialLookup + 1 }
      }
    }))
  }, target)

  await expect(action).toBeVisible()
  await expect(action).toBeEnabled()
  await orcaPage.screenshot({ path: testInfo.outputPath('create-pr-cache-recovery.png') })
})
