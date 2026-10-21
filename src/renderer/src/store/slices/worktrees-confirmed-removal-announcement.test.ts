import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'
import { mergeFetchedWorktrees } from './worktrees/listing/fetched-worktree-merge'
import { isUnsavedRemovalConfirmed } from './worktrees/teardown/confirmed-unsaved-removal-scope'
import {
  createTestStore,
  makeOpenFile,
  makeWorktree,
  seedStore,
  TEST_REPO
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const show = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: show
}))
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

const api = createStoreCascadesMockApi()
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('an announcement while explicit removal awaits the host', () => {
  it.each([false, true])(
    'honors the explicit confirmation scope (confirmed=%s)',
    async (confirmed) => {
      const store = createTestStore()
      const id = `${TEST_REPO.id}::/gone`
      const fileId = '/gone/file.ts'
      const worktree = makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'local' })
      seedStore(store, {
        worktreesByRepo: { [TEST_REPO.id]: [worktree] },
        openFiles: [makeOpenFile({ id: fileId, worktreeId: id })],
        editorDrafts: {}
      })
      const unregister = registerPendingEditorFlush(fileId, () => {
        store.setState({ editorDrafts: { [fileId]: 'latest delayed edit' } })
      })
      let finishHost: () => void = () => {
        throw new Error('Host was not called')
      }
      api.worktrees.remove.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishHost = resolve
          })
      )
      const pending = store.getState().removeWorktree({ id, executionHostId: 'local' }, false, {
        unsavedEditsConfirmed: confirmed
      })
      try {
        await vi.waitFor(() => expect(api.worktrees.remove).toHaveBeenCalledTimes(1))
        expect(isUnsavedRemovalConfirmed('local', id)).toBe(confirmed)
        expect(
          mergeFetchedWorktrees(store.setState, {
            repoId: TEST_REPO.id,
            hostId: 'local',
            ownerWasMissingAtStart: false,
            getState: store.getState,
            requestStartedWorktrees: [worktree],
            refresh: {
              status: 'admitted',
              executionHostId: 'local',
              result: {
                repoId: TEST_REPO.id,
                authoritative: true,
                source: 'git',
                worktrees: []
              }
            }
          })
        ).toBe('applied')
        expect(store.getState().openFiles).toEqual([])
        if (confirmed) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(show).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
          expect(show.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ content: 'latest delayed edit' })
          ])
        }
      } finally {
        unregister()
        finishHost()
        await pending
      }
      expect(isUnsavedRemovalConfirmed('local', id)).toBe(false)
    }
  )

  it('releases confirmation when the host rejects the removal', async () => {
    const store = createTestStore()
    const id = `${TEST_REPO.id}::/retained`
    seedStore(store, {
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id, repoId: TEST_REPO.id, hostId: 'local' })]
      }
    })
    api.worktrees.remove.mockRejectedValueOnce(new Error('Delete failed'))
    expect(
      await store
        .getState()
        .removeWorktree({ id, executionHostId: 'local' }, false, { unsavedEditsConfirmed: true })
    ).toMatchObject({ ok: false })
    expect(isUnsavedRemovalConfirmed('local', id)).toBe(false)
  })
})
