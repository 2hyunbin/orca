import { describe, expect, it } from 'vitest'
import {
  selectLatestReviewLookup,
  selectReviewCacheData,
  selectReviewCacheEntry
} from './review-cache-entry-selection'

type Review = { id: string }
type ReviewEntry = { data: Review | null; fetchedAt: number }

const ACTIVE_KEY = 'repo-active::feature'

function replaceUnrelatedEntry(
  cache: Record<string, ReviewEntry>,
  index: number
): Record<string, ReviewEntry> {
  return {
    ...cache,
    [`repo-background-${index % 100}::feature`]: {
      data: { id: `background-${index}` },
      fetchedAt: index
    }
  }
}

describe('review cache entry selection', () => {
  it('turns unrelated active-panel cache invalidations into stable selections', () => {
    const activeHostedReview = { id: 'hosted-active' }
    const activePullRequest = { id: 'pr-active' }
    let hostedCache: Record<string, ReviewEntry> = {
      [ACTIVE_KEY]: { data: activeHostedReview, fetchedAt: 1 }
    }
    let pullRequestCache: Record<string, ReviewEntry> = {
      [ACTIVE_KEY]: { data: activePullRequest, fetchedAt: 1 }
    }
    let previousHostedMap = hostedCache
    let previousPullRequestMap = pullRequestCache
    let previousHostedSelection = selectReviewCacheData(hostedCache, ACTIVE_KEY)
    let previousPullRequestSelection = selectReviewCacheEntry(pullRequestCache, ACTIVE_KEY)
    let wholeMapInvalidations = 0
    let scopedSelectionInvalidations = 0

    for (let index = 0; index < 200; index += 1) {
      hostedCache = replaceUnrelatedEntry(hostedCache, index)
      pullRequestCache = replaceUnrelatedEntry(pullRequestCache, index)
      if (hostedCache !== previousHostedMap) {
        wholeMapInvalidations += 1
      }
      if (pullRequestCache !== previousPullRequestMap) {
        wholeMapInvalidations += 1
      }

      const hostedSelection = selectReviewCacheData(hostedCache, ACTIVE_KEY)
      const pullRequestSelection = selectReviewCacheEntry(pullRequestCache, ACTIVE_KEY)
      if (hostedSelection !== previousHostedSelection) {
        scopedSelectionInvalidations += 1
      }
      if (pullRequestSelection !== previousPullRequestSelection) {
        scopedSelectionInvalidations += 1
      }

      previousHostedMap = hostedCache
      previousPullRequestMap = pullRequestCache
      previousHostedSelection = hostedSelection
      previousPullRequestSelection = pullRequestSelection
    }

    expect(wholeMapInvalidations).toBe(400)
    expect(scopedSelectionInvalidations).toBe(0)
  })

  it('publishes relevant entry replacements and handles absent keys', () => {
    const first = { data: { id: 'first' }, fetchedAt: 1 }
    const second = { data: { id: 'second' }, fetchedAt: 2 }

    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: first }, ACTIVE_KEY)).toBe(first)
    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: second }, ACTIVE_KEY)).toBe(second)
    expect(selectReviewCacheData({ [ACTIVE_KEY]: second }, ACTIVE_KEY)).toBe(second.data)
    expect(selectReviewCacheEntry({}, ACTIVE_KEY)).toBeUndefined()
    expect(selectReviewCacheData({}, ACTIVE_KEY)).toBeNull()
    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: first }, null)).toBeUndefined()
  })

  it('selects the newer GitHub or hosted lookup, including a confirmed miss', () => {
    const hosted = { data: { provider: 'gitlab' as const, number: 42 }, lookupRevision: 2 }
    const pr = { data: { number: 73 }, lookupRevision: 1 }
    expect(selectLatestReviewLookup(hosted, pr)).toEqual({
      revision: 2,
      provider: 'gitlab',
      number: 42
    })
    expect(selectLatestReviewLookup(hosted, { ...pr, lookupRevision: 3 })).toEqual({
      revision: 3,
      provider: 'github',
      number: 73
    })
    expect(selectLatestReviewLookup(hosted, { data: null, lookupRevision: 3 })).toEqual({
      revision: 3,
      provider: null,
      number: null
    })
    expect(selectLatestReviewLookup({ data: null, lookupRevision: 4 }, pr)).toEqual({
      revision: 4,
      provider: null,
      number: null
    })
  })

  it('does not use missing or invalidated entries as new lookup evidence', () => {
    expect(selectLatestReviewLookup(undefined, undefined)).toBeNull()
    expect(
      selectLatestReviewLookup({ data: null, lookupRevision: 2, stale: true }, undefined)
    ).toBeNull()
    expect(
      selectLatestReviewLookup(
        { data: null, lookupRevision: 2, stale: true },
        { data: null, lookupRevision: 3 }
      )
    ).toEqual({ revision: 3, provider: null, number: null })
  })

  it('selects only the current host and repository branch’s evidence', () => {
    const entry = { data: null, lookupRevision: 1 }
    const cache = {
      'local::repo-1::feature': entry,
      'ssh:other::repo-1::feature': { data: null, lookupRevision: 2 }
    }
    expect(
      selectLatestReviewLookup(selectReviewCacheEntry(cache, 'local::repo-1::feature'), undefined)
        ?.revision
    ).toBe(1)
    expect(
      selectLatestReviewLookup(selectReviewCacheEntry(cache, 'local::repo-2::feature'), undefined)
    ).toBeNull()
    expect(
      selectLatestReviewLookup(selectReviewCacheEntry(cache, 'local::repo-1::other'), undefined)
    ).toBeNull()
  })
})
