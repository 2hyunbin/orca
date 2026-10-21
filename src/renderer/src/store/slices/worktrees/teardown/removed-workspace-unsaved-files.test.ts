import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { createHostTwinFixture } from '../../../host-twin.test-fixture'
import { resetHostTwinModuleStores } from '../../../host-twin-state-projection.test-fixture'
import { createTestStore, makeOpenFile, makeWorktree, TEST_REPO } from '../../store-test-helpers'
import { mergeFetchedWorktrees } from '../listing/fetched-worktree-merge'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'
import { confirmUnsavedDiscard, noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'

const show = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: show
}))
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

type Store = ReturnType<typeof createTestStore>
const RUNTIME = toRuntimeExecutionHostId('env-a')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const shownContents = (call = 0): string[] =>
  (show.mock.calls[call]?.[0] ?? []).map((file: { content: string }) => file.content).sort()

beforeEach(() => {
  show.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})
afterEach(() => vi.unstubAllGlobals())

/** A store whose workspaces each hold one dirty tab `<id>/file.ts` with draft `draft <id>`. */
function dirtyStore(ids: readonly string[], hostId: 'local' | typeof RUNTIME = 'local'): Store {
  const store = createTestStore()
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: hostId }],
    worktreesByRepo: {
      [TEST_REPO.id]: ids.map((id) =>
        makeWorktree({ id, repoId: TEST_REPO.id, hostId, displayName: id.split('/').pop() })
      )
    },
    openFiles: ids.map((id) =>
      makeOpenFile({ id: `${id}/file.ts`, worktreeId: id, isDirty: true })
    ),
    editorDrafts: Object.fromEntries(ids.map((id) => [`${id}/file.ts`, `draft ${id}`]))
  })
  return store
}

const edit = (store: Store, id: string, text: string): void =>
  store.setState((s) => ({ editorDrafts: { ...s.editorDrafts, [`${id}/file.ts`]: text } }))

const GONE = `${TEST_REPO.id}::/gone`

/** Every way a workspace's tabs are purged, each closing `GONE`. */
const purgePaths: [string, (store: Store) => void, ('local' | typeof RUNTIME)?][] = [
  ['worktrees:changed purge', (store) => store.getState().purgeWorktreeTerminalState([GONE])],
  [
    'host announcement',
    (store) =>
      mergeFetchedWorktrees(store.setState, {
        repoId: TEST_REPO.id,
        hostId: 'local',
        ownerWasMissingAtStart: false,
        requestStartedWorktrees: store.getState().worktreesByRepo[TEST_REPO.id] ?? [],
        refresh: {
          status: 'admitted',
          executionHostId: 'local',
          result: { repoId: TEST_REPO.id, authoritative: true, source: 'git', worktrees: [] }
        }
      })
  ],
  [
    'removal teardown',
    (store) => applyRemoveWorktreeSuccessState(store.setState, GONE, new Set(), 'local')
  ],
  [
    'runtime host retirement',
    (store) => store.getState().purgeStaleRuntimeHostState(['env-a']),
    RUNTIME
  ]
]

describe('confirmed discards are a snapshot of the listed text', () => {
  it.each(purgePaths)('%s: unchanged confirmed text closes quietly', async (_, purge, host) => {
    const store = dirtyStore([GONE], host)
    confirmUnsavedDiscard(store.getState, [{ id: GONE, hostId: host ?? 'local' }])
    purge(store)
    expect(store.getState().openFiles).toEqual([])
    await settle()
    expect(show).not.toHaveBeenCalled()
  })

  it.each(purgePaths)('%s: an edit after confirming is offered back', async (_, purge, host) => {
    const store = dirtyStore([GONE], host)
    confirmUnsavedDiscard(store.getState, [{ id: GONE, hostId: host ?? 'local' }])
    edit(store, GONE, 'typed after confirming')
    purge(store)
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(shownContents()).toEqual(['typed after confirming'])
  })

  it('covers listed nested children, and only them', async () => {
    const parent = `${TEST_REPO.id}::/p`
    const child = `${TEST_REPO.id}::/p/child`
    const unlisted = `${TEST_REPO.id}::/p/unlisted`
    const store = dirtyStore([parent, child, unlisted])
    confirmUnsavedDiscard(store.getState, [
      { id: parent, hostId: 'local' },
      { id: child, hostId: 'local' }
    ])
    store.getState().purgeWorktreeTerminalState([parent, child, unlisted])
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(shownContents()).toEqual([`draft ${unlisted}`])
  })

  it('counts delayed view text committed after confirming as a new edit', async () => {
    const store = dirtyStore([GONE])
    confirmUnsavedDiscard(store.getState, [{ id: GONE, hostId: 'local' }])
    const unregister = registerPendingEditorFlush(`${GONE}/file.ts`, () =>
      edit(store, GONE, 'late rich text')
    )
    try {
      store.getState().purgeWorktreeTerminalState([GONE])
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(shownContents()).toEqual(['late rich text'])
    } finally {
      unregister()
    }
  })
})

describe('the closed-files notice', () => {
  it('merges a bulk purge into one toast and dedupes repeated captures', async () => {
    const a = `${TEST_REPO.id}::/a`
    const b = `${TEST_REPO.id}::/b`
    const store = dirtyStore([a, b])
    noticeRemovedUnsavedFiles(store.getState(), new Set([`${a}/file.ts`]))
    store.getState().purgeWorktreeTerminalState([a, b])
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(shownContents()).toEqual([`draft ${a}`, `draft ${b}`])
    expect(show.mock.calls[0]?.[1]).toBe('a, b')
    await settle()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('emits one notice for a full target and a host-twin scope', async () => {
    const f = createHostTwinFixture('local+runtime')
    try {
      const full = 'other::/full'
      f.store.setState((s) => ({
        openFiles: [
          ...s.openFiles,
          makeOpenFile({ id: 'full.ts', worktreeId: full, isDirty: true })
        ],
        editorDrafts: { ...s.editorDrafts, 'full.ts': 'draft full' }
      }))
      f.store
        .getState()
        .purgeWorktreeTerminalState([
          full,
          hostWorktreeTarget({ id: f.workspaceKey, hostId: f.remote.hostId })
        ])
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(shownContents()).toEqual(['draft full', 'unsaved runtime:env-b edit'])
      expect(f.store.getState().editorDrafts[f.local.fileId]).toBe('unsaved local edit')
    } finally {
      resetHostTwinModuleStores(f)
    }
  })

  it('recovers the live text of a shared model, not one tab’s older draft', async () => {
    const store = dirtyStore([GONE])
    const tab = (id: string, isDirty: boolean) =>
      makeOpenFile({ id, filePath: '/w/shared.ts', worktreeId: GONE, isDirty })
    store.setState({
      openFiles: [tab('first', true), tab('second', true)],
      editorDrafts: { first: 'older draft', second: 'newer draft' }
    })
    const unregister = editorModelRegistry.register({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only getModel(uri).getValue().
      editor: { getModel: () => ({ getValue: () => 'live model text' }) } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture only parses the model URI.
      Uri: { parse: (uri: string) => uri } as never
    })
    try {
      store.getState().purgeWorktreeTerminalState([GONE])
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
      expect(shownContents()).toEqual(['live model text'])
    } finally {
      unregister()
    }
  })

  it('falls back to a sharing tab’s draft when the dirty tab has none', async () => {
    const store = dirtyStore([GONE])
    const tab = (id: string) =>
      makeOpenFile({ id, filePath: '/w/shared.ts', worktreeId: GONE, isDirty: true })
    store.setState({ openFiles: [tab('first'), tab('second')], editorDrafts: { second: 'kept' } })
    store.getState().purgeWorktreeTerminalState([GONE])
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(shownContents()).toEqual(['kept'])
  })
})
