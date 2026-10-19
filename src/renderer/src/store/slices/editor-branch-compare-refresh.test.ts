import { describe, expect, it, vi } from 'vitest'
import type { GitBranchCompareResult } from '../../../../shared/git-diff-compare-types'
import { createEditorStore } from './editor-slice-test-harness'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const initial: GitBranchCompareResult = {
  summary: {
    baseRef: 'parent-one',
    baseOid: 'base-one',
    compareRef: 'feature',
    headOid: 'head',
    mergeBase: 'base-one',
    changedFiles: 1,
    commitsAhead: 0,
    commitsBehind: 1,
    status: 'ready'
  },
  entries: [{ path: 'example.ts', status: 'modified', added: 1, removed: 1 }]
}

describe('branch comparison refresh', () => {
  it('replaces line counts when selecting another base changes the same file', () => {
    const store = createEditorStore()
    store.getState().beginGitBranchCompareRequest('wt-1', 'first', 'parent-one')
    store.getState().setGitBranchCompareResult('wt-1', 'first', initial)
    const next: GitBranchCompareResult = {
      summary: {
        ...initial.summary,
        baseRef: 'parent-two',
        baseOid: 'base-two',
        mergeBase: 'base-two',
        commitsBehind: 2
      },
      entries: [{ path: 'example.ts', status: 'modified', added: 1, removed: 2 }]
    }

    store.getState().beginGitBranchCompareRequest('wt-1', 'second', 'parent-two')
    store.getState().setGitBranchCompareResult('wt-1', 'second', next)

    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual(next.entries)
    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(next.summary)
  })

  it('updates the pinned left revision when a host switches from legacy to direct comparison', () => {
    const store = createEditorStore()
    store.getState().beginGitBranchCompareRequest('wt-1', 'legacy', 'parent-one')
    store.getState().setGitBranchCompareResult('wt-1', 'legacy', {
      ...initial,
      summary: { ...initial.summary, mergeBase: 'common-ancestor' }
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'direct', 'parent-one', {
      preserveExistingSummary: true
    })
    store.getState().setGitBranchCompareResult('wt-1', 'direct', initial)

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']?.mergeBase).toBe('base-one')
    const entries = store.getState().gitBranchChangesByWorktree
    const summaries = store.getState().gitBranchCompareSummaryByWorktree
    store
      .getState()
      .beginGitBranchCompareRequest('wt-1', 'same', 'parent-one', { preserveExistingSummary: true })
    store.getState().setGitBranchCompareResult('wt-1', 'same', initial)
    expect(store.getState().gitBranchChangesByWorktree).toBe(entries)
    expect(store.getState().gitBranchCompareSummaryByWorktree).toBe(summaries)
  })
})
