import { afterEach, describe, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  claimCombinedDiffViewMemory,
  clearCombinedDiffViewMemory,
  readCombinedDiffViewMemory,
  updateCombinedDiffViewMemory
} from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import { applyRemoveWorktreeSuccessState } from './worktrees/teardown/remove-worktree-store-cleanup'
import { buildWorktreeRenameState } from './worktrees/session/worktree-identity-rename-state'

const removed = 'repo::/workspace/deleted'
const kept = 'repo::/workspace/kept'

function seedDiff(worktreeId: string): string {
  const key = `${worktreeId}::all-diffs::uncommitted::pane`
  claimCombinedDiffViewMemory(key, worktreeId)
  updateCombinedDiffViewMemory(key, {
    view: {
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
    },
    scrollTop: 42,
    scrollAnchor: { key: 'source', offset: 0 }
  })
  return key
}

afterEach(() => {
  clearCombinedDiffViewMemory()
})

describe('removed workspace diff memory', () => {
  it('preserves cached bodies and scroll through rename, then releases them on deletion', () => {
    const key = seedDiff(removed)
    const keptKey = seedDiff(kept)
    const renamed = 'repo::/workspace/renamed'
    const store = createTestStore()
    const sections = readCombinedDiffViewMemory(key)?.view?.sections
    store.setState(buildWorktreeRenameState(store.getState(), removed, renamed))
    expect(readCombinedDiffViewMemory(key)).toMatchObject({
      worktreeId: renamed,
      scrollTop: 42,
      scrollAnchor: { key: 'source', offset: 0 }
    })
    expect(readCombinedDiffViewMemory(key)?.view?.sections).toBe(sections)
    buildWorktreePurgeState(store.getState(), [removed])
    expect(readCombinedDiffViewMemory(key)).toBeDefined()
    buildWorktreePurgeState(store.getState(), [renamed])
    expect(readCombinedDiffViewMemory(key)).toBeUndefined()
    expect(readCombinedDiffViewMemory(keptKey)).toBeDefined()
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
      expect(readCombinedDiffViewMemory(removedKey)).toBeUndefined()
      expect(readCombinedDiffViewMemory(keptKey)).toBeDefined()
      expect(readCombinedDiffViewMemory(overlappingKey)).toBeDefined()
    }
  )

  it('ignores the unmount write of a viewer whose workspace was already removed', () => {
    const key = seedDiff(removed)
    const store = createTestStore()
    applyRemoveWorktreeSuccessState(store.setState, removed, new Set())
    updateCombinedDiffViewMemory(key, { scrollTop: 7, scrollAnchor: { key: 'source', offset: 3 } })
    expect(readCombinedDiffViewMemory(key)).toBeUndefined()
    // A workspace recreated under the same id starts fresh once its viewer mounts.
    claimCombinedDiffViewMemory(key, removed)
    updateCombinedDiffViewMemory(key, { scrollTop: 7 })
    expect(readCombinedDiffViewMemory(key)).toEqual({ worktreeId: removed, scrollTop: 7 })
  })

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
    expect(readCombinedDiffViewMemory(key)?.scrollTop).toBe(42)
  })

  it('releases folder workspace views using their recorded owner', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const key = seedDiff(workspaceId)
    const store = createTestStore()
    buildWorktreePurgeState(store.getState(), [workspaceId])
    expect(readCombinedDiffViewMemory(key)).toBeUndefined()
  })
})
