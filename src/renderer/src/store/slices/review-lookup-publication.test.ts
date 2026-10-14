import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makePR, mockApi } from './github-slice-test-harness'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import { selectLatestReviewLookup } from '../../components/right-sidebar/review-cache-entry-selection'

const repoPath = '/repo'
const repoId = 'repo-1'
const branch = 'feature'
const cacheKey = `${repoId}::${branch}`
const hostedKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
const aliases = [{ cacheKey, repoPath, repoId, branch }]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100)
  mockApi.hostedReview.forBranch.mockReset()
  mockApi.cache.getGitHub.mockReset()
  mockApi.cache.setGitHub.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('accepted review lookup publication revisions', () => {
  it.each([-86_400_000, 86_400_000])(
    'orders a hosted lookup after a GitHub miss with host clock offset %i',
    async (offset) => {
      const store = createTestStore()
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases,
        reason: 'visible',
        outcome: { kind: 'no-pr', fetchedAt: Date.now() + offset }
      })
      const earlier = store.getState().prCache[cacheKey]
      expect(earlier.lookupRevision).toEqual(expect.any(Number))
      mockApi.hostedReview.forBranch.mockResolvedValueOnce(null)
      await store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId, force: true })
      const hosted = store.getState().hostedReviewCache[hostedKey]
      expect(hosted.lookupRevision).toBeGreaterThan(earlier.lookupRevision ?? 0)
      expect(selectLatestReviewLookup(hosted, earlier)?.revision).toBe(hosted.lookupRevision)
    }
  )

  it('gives the same GitHub publication one revision across both caches', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases,
      reason: 'visible',
      outcome: { kind: 'found', pr: makePR(), fetchedAt: 50 }
    })
    const state = store.getState()
    expect(state.prCache[cacheKey].lookupRevision).toBe(
      state.hostedReviewCache[hostedKey].lookupRevision
    )
    expect(state.prCache[cacheKey].lookupRevision).toEqual(expect.any(Number))
    const publication = selectLatestReviewLookup(
      state.hostedReviewCache[hostedKey],
      state.prCache[cacheKey]
    )
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 0,
      aliases,
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 200 }
    })
    expect(
      selectLatestReviewLookup(
        store.getState().hostedReviewCache[hostedKey],
        store.getState().prCache[cacheKey]
      )
    ).toEqual(publication)
  })

  it('does not publish preserved results on failure or cache hits', async () => {
    const store = createTestStore()
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(null)
    await store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId })
    const entry = store.getState().hostedReviewCache[hostedKey]
    await store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId })
    expect(store.getState().hostedReviewCache[hostedKey]).toBe(entry)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockApi.hostedReview.forBranch.mockRejectedValueOnce(new Error('unavailable'))
      await store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId, force: true })
      expect(store.getState().hostedReviewCache[hostedKey]).toBe(entry)
    } finally {
      error.mockRestore()
    }
  })

  it('drops persisted revisions when hydrating a new renderer session', async () => {
    const store = createTestStore()
    mockApi.cache.getGitHub.mockResolvedValueOnce({
      pr: { [cacheKey]: { data: null, fetchedAt: 100, lookupRevision: 1_000_000 } }
    })
    await store.getState().initGitHubCache()
    expect(selectLatestReviewLookup(undefined, store.getState().prCache[cacheKey])).toBeNull()
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases,
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 101 }
    })
    expect(
      selectLatestReviewLookup(undefined, store.getState().prCache[cacheKey])?.revision
    ).toEqual(expect.any(Number))
  })
})
