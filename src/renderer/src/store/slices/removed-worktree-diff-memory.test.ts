import { afterEach, describe, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  combinedDiffScrollAnchorCache,
  combinedDiffScrollTopCache,
  combinedDiffViewStateCache
} from '@/components/editor/combined-diff/remember-view/combined-diff-view-memory'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import { applyRemoveWorktreeSuccessState } from './worktrees/teardown/remove-worktree-store-cleanup'
import { buildWorktreeRenameState } from './worktrees/session/worktree-identity-rename-state'

const removed = 'repo::/workspace/deleted'
const kept = 'repo::/workspace/kept'

function seedDiff(worktreeId: string): string {
  const key = `${worktreeId}::all-diffs::uncommitted::pane`
  combinedDiffViewStateCache.set(key, {
    worktreeId,
    entrySignature: 'entries',
    gitStatusSignature: '',
    sections: [
      {
        key: 'source',
        path: 'source.ts',
        status: 'modified',
        originalContent: 'before'.repeat(1000),
        modifiedContent: 'after'.repeat(1000),
        collapsed: false,
        loading: false,
        dirty: false,
        diffResult: null,
        largeDiffRenderLimit: null
      }
    ],
    sectionHeights: {},
    loadedIndices: [0],
    scrollTop: 42,
    sideBySide: true
  })
  combinedDiffScrollTopCache.set(key, 42)
  combinedDiffScrollAnchorCache.set(key, { key: 'source', offset: 0 })
  return key
}

afterEach(() => {
  combinedDiffViewStateCache.clear()
  combinedDiffScrollTopCache.clear()
  combinedDiffScrollAnchorCache.clear()
})

describe('removed workspace diff memory', () => {
  it('preserves cached bodies and scroll through rename, then releases them on deletion', () => {
    const key = seedDiff(removed)
    const keptKey = seedDiff(kept)
    const renamed = 'repo::/workspace/renamed'
    const store = createTestStore()
    const sections = combinedDiffViewStateCache.get(key)?.sections
    store.setState(buildWorktreeRenameState(store.getState(), removed, renamed))
    expect(combinedDiffViewStateCache.get(key)?.sections).toBe(sections)
    expect(combinedDiffScrollTopCache.get(key)).toBe(42)
    expect(combinedDiffScrollAnchorCache.get(key)).toEqual({ key: 'source', offset: 0 })
    buildWorktreePurgeState(store.getState(), [removed])
    expect(combinedDiffViewStateCache.has(key)).toBe(true)
    buildWorktreePurgeState(store.getState(), [renamed])
    expect(combinedDiffViewStateCache.has(key)).toBe(false)
    expect(combinedDiffScrollTopCache.has(key)).toBe(false)
    expect(combinedDiffScrollAnchorCache.has(key)).toBe(false)
    expect(combinedDiffViewStateCache.has(keptKey)).toBe(true)
  })

  it.each(['listing', 'explicit'] as const)(
    'releases cached file bodies on %s removal and preserves another workspace',
    (path) => {
      const removedKey = seedDiff(removed)
      const keptKey = seedDiff(kept)
      const overlappingKey = seedDiff(`${removed}::all-diffs::nested-directory`)
      const store = createTestStore()
      if (path === 'listing') {
        store.setState(buildWorktreePurgeState(store.getState(), [removed]))
      } else {
        applyRemoveWorktreeSuccessState(store.setState, removed, new Set())
      }
      for (const cache of [
        combinedDiffViewStateCache,
        combinedDiffScrollTopCache,
        combinedDiffScrollAnchorCache
      ]) {
        expect(cache.has(removedKey)).toBe(false)
        expect(cache.has(keptKey)).toBe(true)
        expect(cache.has(overlappingKey)).toBe(true)
      }
    }
  )

  it('keeps cached views when a different host still owns the same workspace id', () => {
    const key = seedDiff(removed)
    const store = createTestStore()
    store.setState({
      worktreesByRepo: {
        repo: [
          makeWorktree({ id: removed, repoId: 'repo', hostId: 'local' }),
          makeWorktree({ id: removed, repoId: 'repo', hostId: 'runtime:remote' })
        ]
      }
    })
    buildWorktreePurgeState(store.getState(), [
      hostWorktreeTarget({ id: removed, hostId: 'runtime:remote' })
    ])
    expect(combinedDiffViewStateCache.has(key)).toBe(true)
    expect(combinedDiffScrollTopCache.get(key)).toBe(42)
  })

  it('releases folder workspace views using their recorded owner', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const key = seedDiff(workspaceId)
    const store = createTestStore()
    buildWorktreePurgeState(store.getState(), [workspaceId])
    expect(combinedDiffViewStateCache.has(key)).toBe(false)
  })
})
