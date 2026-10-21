import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { createHostTwinFixture } from '../../../host-twin.test-fixture'
import { resetHostTwinModuleStores } from '../../../host-twin-state-projection.test-fixture'
import { createTestStore, makeOpenFile, makeTab, makeWorktree } from '../../store-test-helpers'
import {
  beginConfirmedUnsavedRemoval,
  isUnsavedRemovalConfirmed
} from './confirmed-unsaved-removal-scope'
import { buildAnnouncedRemovalPurgeState } from './announced-removal-purge-state'

const show = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: show
}))
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  show.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})
afterEach(() => vi.unstubAllGlobals())
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function dirtyWorkspace(store: ReturnType<typeof createTestStore>, id: string) {
  store.setState((s) => ({
    openFiles: [
      ...s.openFiles,
      makeOpenFile({ id: `${id}/file.ts`, worktreeId: id, isDirty: true })
    ],
    editorDrafts: { ...s.editorDrafts, [`${id}/file.ts`]: `draft ${id}` }
  }))
}

describe('combined removal recovery', () => {
  it('emits one notice for a full target and two different host-twin scopes', async () => {
    const f = createHostTwinFixture('local+runtime')
    try {
      const full = 'other::/full'
      dirtyWorkspace(f.store, full)
      // A second scope removes the local copy, keeping its remote twin.
      const second = `${f.projectId}::/second`
      f.store.setState((s) => ({
        worktreesByRepo: {
          ...s.worktreesByRepo,
          [f.projectId]: [
            ...(s.worktreesByRepo[f.projectId] ?? []),
            makeWorktree({ id: second, repoId: f.projectId, hostId: 'local' }),
            makeWorktree({ id: second, repoId: f.projectId, hostId: f.remote.hostId })
          ]
        }
      }))
      dirtyWorkspace(f.store, second)
      f.store
        .getState()
        .purgeWorktreeTerminalState([
          full,
          hostWorktreeTarget({ id: f.workspaceKey, hostId: f.remote.hostId }),
          hostWorktreeTarget({ id: second, hostId: 'local' })
        ])
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(show.mock.calls[0]?.[0].map((f: { content: string }) => f.content).sort()).toEqual(
        [`draft ${full}`, `draft ${second}`, 'unsaved runtime:env-b edit'].sort()
      )
      expect(f.store.getState().editorDrafts[f.local.fileId]).toBe('unsaved local edit')
    } finally {
      resetHostTwinModuleStores(f)
    }
  })

  it('host-qualified confirmation suppresses only matching targets in the same batch', async () => {
    const f = createHostTwinFixture('local+runtime')
    const release = beginConfirmedUnsavedRemoval(f.remote.hostId, f.workspaceKey)
    try {
      const other = 'other::/full'
      dirtyWorkspace(f.store, other)
      f.store.setState((s) =>
        buildAnnouncedRemovalPurgeState(s, [
          { id: f.workspaceKey, hostId: f.remote.hostId },
          { id: other, hostId: 'local' }
        ])
      )
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(show.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ content: `draft ${other}` })
      ])
      expect(f.store.getState().openFiles.map((f) => f.id)).toEqual([f.local.fileId])
    } finally {
      release()
      resetHostTwinModuleStores(f)
    }
  })

  it.each(['ssh:other', 'local'] as const)(
    'does not suppress an unrelated %s host/target',
    async (host) => {
      const store = createTestStore()
      dirtyWorkspace(store, 'r::/gone')
      const release = beginConfirmedUnsavedRemoval(
        host,
        host === 'local' ? 'r::/different' : 'r::/gone'
      )
      try {
        store.setState((s) =>
          buildAnnouncedRemovalPurgeState(s, [{ id: 'r::/gone', hostId: 'local' }])
        )
        await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      } finally {
        release()
      }
    }
  )

  it('ref-counts concurrent confirmations and releases them idempotently', () => {
    const releaseA = beginConfirmedUnsavedRemoval('local', 'r::/gone')
    const releaseB = beginConfirmedUnsavedRemoval('local', 'r::/gone')
    releaseA()
    releaseA()
    expect(isUnsavedRemovalConfirmed('local', 'r::/gone')).toBe(true)
    releaseB()
    expect(isUnsavedRemovalConfirmed('local', 'r::/gone')).toBe(false)
  })

  it('stays silent for a matching confirmed announcement', async () => {
    const store = createTestStore()
    dirtyWorkspace(store, 'r::/gone')
    const release = beginConfirmedUnsavedRemoval('local', 'r::/gone')
    try {
      store.setState((s) =>
        buildAnnouncedRemovalPurgeState(s, [{ id: 'r::/gone', hostId: 'local' }])
      )
      await settle()
      expect(show).not.toHaveBeenCalled()
      expect(store.getState().openFiles).toEqual([])
    } finally {
      release()
    }
  })
})

describe('stale runtime host delayed text', () => {
  it('flushes exactly doomed nested, detected-only, restored and setup-only documents', async () => {
    const store = createTestStore()
    const nested = 'nested::/nested'
    const detected = 'detected::/detected'
    const restored = 'restored::/restored'
    const setup = 'setup::/setup'
    const survivor = 'nested::/survives'
    const ids = [nested, detected, restored, setup, survivor]
    const row = makeWorktree({ id: detected, repoId: 'detected', hostId: 'runtime:env-a' })
    store.setState({
      repos: [],
      worktreesByRepo: {
        nested: [
          makeWorktree({
            id: nested,
            repoId: 'nested',
            hostId: 'ssh:nested',
            runtimeOwnerEnvironmentId: 'env-a'
          }),
          makeWorktree({ id: survivor, repoId: 'nested', hostId: 'local' })
        ]
      },
      detectedWorktreesByRepo: {
        detected: {
          repoId: 'detected',
          authoritative: true,
          source: 'git',
          worktrees: [{ ...row, ownership: 'orca-managed', visible: true, selectedCheckout: false }]
        }
      },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [restored]: 'runtime:env-a' },
      projectHostSetups: [
        {
          id: 'setup',
          projectId: 'setup',
          repoId: 'setup',
          hostId: 'runtime:env-a',
          path: '/setup',
          displayName: 'Setup',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      tabsByWorktree: { [setup]: [makeTab({ id: 'setup-tab', worktreeId: setup })] },
      openFiles: ids.map((id) => makeOpenFile({ id: `${id}/file.ts`, worktreeId: id })),
      editorDrafts: {}
    })
    const flushed: string[] = []
    const unregister = ids.map((id) =>
      registerPendingEditorFlush(`${id}/file.ts`, () => {
        flushed.push(id)
        store.setState((s) => ({
          editorDrafts: { ...s.editorDrafts, [`${id}/file.ts`]: `late ${id}` }
        }))
      })
    )
    try {
      store.getState().purgeStaleRuntimeHostState(['env-a'])
      expect(flushed.sort()).toEqual([nested, detected, restored, setup].sort())
      expect(store.getState().openFiles.map((f) => f.worktreeId)).toEqual([survivor])
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(show.mock.calls[0]?.[0].map((f: { content: string }) => f.content).sort()).toEqual(
        [nested, detected, restored, setup].map((id) => `late ${id}`).sort()
      )
    } finally {
      unregister.forEach((f) => f())
    }
  })
})
