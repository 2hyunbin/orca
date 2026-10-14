// @vitest-environment happy-dom

import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../src/shared/hosted-review'
import type { HostedReviewExecutionOptions } from '../../src/main/source-control/hosted-review-git-options'
import { getHostedReviewForBranch } from '../../src/main/source-control/hosted-review'
import { getHostedReviewCreationEligibility } from '../../src/main/source-control/hosted-review-creation'
import { __resetHostedReviewBranchCacheForTests } from '../../src/main/source-control/hosted-review-branch-cache'
import { nextReviewLookupRevision } from '../../src/renderer/src/store/review-lookup-publication'
import { selectLatestReviewLookup } from '../../src/renderer/src/components/right-sidebar/review-cache-entry-selection'
import {
  makeInput,
  renderEligibility
} from '../../src/renderer/src/components/right-sidebar/source-control/review/hosted-review-eligibility-test-harness'

const { providerLookup, detectProvider } = vi.hoisted(() => ({
  providerLookup: vi.fn<() => Promise<HostedReviewInfo | null>>(),
  detectProvider: vi.fn<() => Promise<'gitlab' | 'unsupported'>>()
}))

vi.mock('../../src/main/source-control/forge-provider', () => ({
  detectHostedReviewProvider: detectProvider,
  getForgeProviderForRepository: async () => ({ id: 'gitlab', getReviewForBranch: providerLookup })
}))
vi.mock('../../src/main/github/client', () => ({ getRepoSlug: vi.fn() }))
vi.mock('../../src/main/source-control/hosted-review-creation-provider', () => ({
  isProviderAuthenticated: async () => true
}))
vi.mock('../../src/main/source-control/hosted-review-creation-git-state', () => ({
  baseRefExistsOnRemote: async () => true,
  hostedReviewExecutionContext: (options: HostedReviewExecutionOptions) => ({
    localGitExecOptions: options.localGitExecOptions
  }),
  stripRefPrefix: (ref: string) => ref.replace(/^refs\/heads\//, '')
}))

const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 42,
  title: 'Review',
  state: 'open',
  url: 'https://gitlab.com/acme/orca/-/merge_requests/42',
  status: 'success',
  updatedAt: '2026-10-13T00:00:00Z',
  mergeable: 'MERGEABLE'
}
const branch = 'feature'
const repoPath = '/repo'
const worktreePath = '/worktrees/feature'
const executionHostId = 'local' as const

beforeEach(() => {
  __resetHostedReviewBranchCacheForTests()
  providerLookup.mockReset()
  detectProvider.mockResolvedValue('gitlab')
})
afterEach(() => {
  cleanup()
  __resetHostedReviewBranchCacheForTests()
})

function probe(args: HostedReviewCreationEligibilityArgs) {
  return getHostedReviewCreationEligibility({
    ...args,
    repoPath: args.worktreePath ?? args.repoPath,
    executionHostId,
    localGitExecOptions: { admissionTier: 'interactive' }
  })
}

async function publishRootLookup() {
  const data = await getHostedReviewForBranch({
    repoPath,
    branch,
    executionHostId,
    force: true,
    localGitExecOptions: { admissionTier: 'background' }
  })
  return selectLatestReviewLookup({ data, lookupRevision: nextReviewLookupRevision() }, undefined)
}

describe('eligibility recovery through the real host cache', () => {
  it.each([true, false])(
    'revalidates the selected worktree after a root lookup (existing review: %s)',
    async (initiallyFound) => {
      providerLookup.mockResolvedValue(initiallyFound ? review : null)
      const getEligibility = vi.fn(probe)
      const input = makeInput({
        activeRepoPath: repoPath,
        worktreePath,
        branchName: branch,
        effectiveBaseRef: 'origin/main',
        hasUncommittedEntries: false,
        remoteStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        getHostedReviewCreationEligibility: getEligibility
      })
      const { result, rerender } = renderEligibility(input)
      await waitFor(() =>
        expect(result.current.hostedReviewCreation?.canCreate).toBe(!initiallyFound)
      )

      providerLookup.mockResolvedValue(initiallyFound ? null : review)
      const hostedReviewLookup = await publishRootLookup()
      // A normal eligibility request demonstrably still sees the worktree's cached answer.
      expect((await probe(getEligibility.mock.calls[0][0])).canCreate).toBe(!initiallyFound)
      expect(providerLookup).toHaveBeenCalledTimes(2)

      rerender({ ...input, hostedReviewLookup })
      await waitFor(() =>
        expect(result.current.hostedReviewCreation?.canCreate).toBe(initiallyFound)
      )
      expect(getEligibility).toHaveBeenLastCalledWith(
        expect.objectContaining({ revalidateReview: true })
      )
      expect(providerLookup).toHaveBeenCalledTimes(3)
      expect(result.current.hostedReviewCreation?.reviewLookupOutcome).toBe(
        initiallyFound ? 'not_found' : 'found'
      )
      await getHostedReviewForBranch({
        repoPath,
        branch,
        executionHostId,
        localGitExecOptions: { admissionTier: 'background' }
      })
      expect(providerLookup).toHaveBeenCalledTimes(3)
    }
  )

  it('recovers on a local publication even when an older GitHub miss has a future host timestamp', async () => {
    providerLookup.mockResolvedValue(null)
    detectProvider.mockResolvedValue('unsupported')
    const olderGitHubMiss = {
      data: null,
      fetchedAt: Date.now() + 86_400_000,
      lookupRevision: nextReviewLookupRevision()
    }
    const input = makeInput({
      branchName: branch,
      worktreePath,
      effectiveBaseRef: 'origin/main',
      getHostedReviewCreationEligibility: vi.fn(probe),
      hostedReviewLookup: selectLatestReviewLookup(undefined, olderGitHubMiss)
    })
    const { result, rerender } = renderEligibility(input)
    await waitFor(() => expect(result.current.hostedReviewCreation?.provider).toBe('unsupported'))
    detectProvider.mockResolvedValue('gitlab')
    const data = await getHostedReviewForBranch({ repoPath, branch, executionHostId, force: true })
    const hosted = { data, fetchedAt: Date.now(), lookupRevision: nextReviewLookupRevision() }
    rerender({ ...input, hostedReviewLookup: selectLatestReviewLookup(hosted, olderGitHubMiss) })
    await waitFor(() => expect(result.current.action?.label).toBe('Create MR'))
    expect(input.getHostedReviewCreationEligibility).toHaveBeenCalledTimes(2)
  })

  it('retires a pending worktree lookup instead of joining it after publication', async () => {
    let finishOld: (value: HostedReviewInfo | null) => void = () => {}
    providerLookup.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve
      })
    )
    const old = getHostedReviewForBranch({
      repoPath: worktreePath,
      branch,
      executionHostId,
      active: true,
      localGitExecOptions: { admissionTier: 'interactive' }
    })
    providerLookup.mockResolvedValue(review)
    await publishRootLookup()
    const fresh = await probe({
      repoPath,
      worktreePath,
      branch,
      base: 'origin/main',
      hasUpstream: true,
      revalidateReview: true
    })
    expect(fresh.reviewLookupOutcome).toBe('found')
    await act(async () => {
      finishOld(null)
      await old
    })
    expect(
      (await probe({ repoPath, worktreePath, branch, base: 'origin/main', hasUpstream: true }))
        .reviewLookupOutcome
    ).toBe('found')
    expect(providerLookup).toHaveBeenCalledTimes(3)
  })

  it('revalidates a publication already present when the panel opens', async () => {
    providerLookup.mockResolvedValue(review)
    await probe({ repoPath, worktreePath, branch, base: 'origin/main', hasUpstream: true })
    providerLookup.mockResolvedValue(null)
    const hostedReviewLookup = await publishRootLookup()
    const input = makeInput({
      branchName: branch,
      worktreePath,
      hostedReviewLookup,
      getHostedReviewCreationEligibility: vi.fn(probe)
    })
    const { result } = renderEligibility(input)
    await waitFor(() => expect(result.current.action?.label).toBe('Create MR'))
    expect(providerLookup).toHaveBeenCalledTimes(3)
  })

  it('does not reuse a cached answer when publication-driven revalidation fails', async () => {
    providerLookup.mockResolvedValue(null)
    const args = { repoPath, worktreePath, branch, base: 'origin/main', hasUpstream: true }
    expect((await probe(args)).canCreate).toBe(true)
    providerLookup.mockRejectedValue(new Error('provider unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await probe({ ...args, revalidateReview: true })).toMatchObject({
        canCreate: false,
        reviewLookupOutcome: 'unavailable'
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps other execution hosts cached when the selected worktree is revalidated', async () => {
    providerLookup.mockResolvedValue(review)
    const otherHost = { repoPath: worktreePath, branch, executionHostId: 'ssh:other' as const }
    await getHostedReviewForBranch(otherHost)
    providerLookup.mockResolvedValue(null)
    await probe({
      repoPath,
      worktreePath,
      branch,
      base: 'origin/main',
      hasUpstream: true,
      revalidateReview: true
    })
    expect(await getHostedReviewForBranch(otherHost)).toEqual(review)
    expect(providerLookup).toHaveBeenCalledTimes(2)
  })
})
