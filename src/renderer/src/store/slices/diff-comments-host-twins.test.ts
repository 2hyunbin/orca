import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from './store-test-helpers'
import { selectWorktreeDiffCommentsOrEmpty } from '../worktree-diff-comments-selector'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const updateMeta = vi.fn()

vi.stubGlobal('window', {
  api: { worktrees: { updateMeta }, ui: { set: vi.fn() } }
})

const REPO = 'repo-1'
const WT = `${REPO}::/work/feature`

function worktree(hostId: Worktree['hostId'], diffComments: DiffComment[] = []): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/work/feature',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId,
    diffComments
  }
}

function note(id: string, body: string): DiffComment {
  return { id, worktreeId: WT, filePath: 'a', lineNumber: 1, body, createdAt: 1, side: 'modified' }
}

const repoBase = {
  id: REPO,
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

// Same project and worktree id on this computer and on an SSH host.
function createTwinStore(activeHostId: Worktree['hostId'] | null) {
  const repos: Repo[] = [
    { ...repoBase, executionHostId: 'local' },
    { ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }
  ]
  const store = createTestStore()
  store.setState({
    activeWorktreeId: activeHostId ? WT : null,
    activeWorkspaceExecutionHostId: activeHostId,
    repos,
    worktreesByRepo: { [REPO]: [worktree('local'), worktree('ssh:box')] }
  })
  return store
}

function rowNotes(store: ReturnType<typeof createTwinStore>, hostId: string): string[] {
  const row = store.getState().worktreesByRepo[REPO].find((w) => w.hostId === hostId)
  return (row?.diffComments ?? []).map((comment) => comment.body)
}

function addNote(store: ReturnType<typeof createTwinStore>) {
  return store.getState().addDiffComment({
    worktreeId: WT,
    filePath: 'README.md',
    lineNumber: 1,
    body: 'ssh note',
    side: 'modified'
  })
}

beforeEach(() => {
  updateMeta.mockReset()
  updateMeta.mockResolvedValue({})
})

describe('diff comments on twin worktrees', () => {
  it('saves to the open twin and names its host', async () => {
    const store = createTwinStore('ssh:box')

    expect(await addNote(store)).not.toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual(['ssh note'])
    expect(rowNotes(store, 'local')).toEqual([])
    // What the notes panel and diff gutters render.
    expect(selectWorktreeDiffCommentsOrEmpty(store.getState(), WT).map((c) => c.body)).toEqual([
      'ssh note'
    ])
    expect(updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, executionHostId: 'ssh:box' })
    )
  })

  it('rolls back only the twin it wrote', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local', [note('l1', 'local note')]), worktree('ssh:box')]
      }
    })
    updateMeta.mockRejectedValueOnce(new Error('write failed'))

    expect(await addNote(store)).toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('refuses when no host names the twin instead of editing both', async () => {
    const store = createTwinStore(null)

    expect(await addNote(store)).toBeNull()

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(rowNotes(store, 'local')).toEqual([])
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('drops a queued save whose twin left, instead of writing the other copy under its host', async () => {
    const store = createTwinStore('ssh:box')
    store.setState({
      worktreesByRepo: {
        [REPO]: [worktree('local', [note('l1', 'local note')]), worktree('ssh:box')]
      }
    })

    const pending = addNote(store)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local', [note('l1', 'local note')])] } })

    expect(await pending).toBeNull()
    expect(updateMeta).not.toHaveBeenCalled()
    expect(rowNotes(store, 'local')).toEqual(['local note'])
  })

  it('keeps one queue for a copy when its twin leaves between saves', async () => {
    const store = createTwinStore('ssh:box')
    updateMeta.mockRejectedValue(new Error('write failed'))

    const first = addNote(store)
    // The local copy goes before the second save, so the SSH copy is the only row left.
    store.setState({ worktreesByRepo: { [REPO]: [store.getState().worktreesByRepo[REPO][1]] } })
    const second = addNote(store)

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(rowNotes(store, 'ssh:box')).toEqual([])
  })

  it('writes every duplicated row of one copy, so reads see the note', async () => {
    const store = createTwinStore(null)
    store.setState({ worktreesByRepo: { [REPO]: [worktree('local'), worktree('local')] } })

    expect(await addNote(store)).not.toBeNull()

    expect(
      store
        .getState()
        .getDiffComments(WT)
        .map((c) => c.body)
    ).toEqual(['ssh note'])
  })

  it('clears delivered notes on their own copy after the user moved away', async () => {
    const store = createTwinStore('ssh:box')
    const sent = await addNote(store)
    if (!sent) {
      throw new Error('note was not saved')
    }
    store.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })

    expect(await store.getState().clearDeliveredDiffComments(WT, [sent])).toBe(true)

    expect(rowNotes(store, 'ssh:box')).toEqual([])
    expect(updateMeta).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionHostId: 'ssh:box', updates: { diffComments: [] } })
    )
  })
})
