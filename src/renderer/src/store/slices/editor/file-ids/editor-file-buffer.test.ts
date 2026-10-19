import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createEditorStore,
  stubEditorWindowWithDisk,
  type FakeEditorDisk
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { createEditorSaveQueue } from '@/components/editor/editor-save-queue'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { getEditorBufferKey, getSameBufferFileIds } from './editor-file-buffer'

const FILE = '/repo/a.ts'

function openTab(store: StoreApi<AppState>, worktreeId: string): string {
  store.getState().openFile({
    filePath: FILE,
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    mode: 'edit'
  })
  return store.getState().openFiles.at(-1)?.id ?? ''
}

function tab(store: StoreApi<AppState>, id: string): OpenFile | undefined {
  return store.getState().openFiles.find((file) => file.id === id)
}

describe('one editor buffer per physical file', () => {
  let store: StoreApi<AppState>
  let disk: FakeEditorDisk

  beforeEach(() => {
    disk = stubEditorWindowWithDisk()
    store = createEditorStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
          makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
        ],
        'repo-ssh': [
          makeWorktree({ id: 'wt-ssh', repoId: 'repo-ssh', path: '/repo', hostId: 'ssh:target' })
        ]
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('gives two workspaces one model, draft and dirty flag', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    const state = store.getState()
    expect(a).not.toBe(b)
    expect(getEditorBufferKey(tab(store, a)!, state)).toBe(
      getEditorBufferKey(tab(store, b)!, state)
    )

    store.getState().setEditorDraft(a, 'typed in A')
    store.getState().markFileDirty(a, true)

    expect(store.getState().editorDrafts[b]).toBe('typed in A')
    expect(tab(store, b)?.isDirty).toBe(true)
  })

  it('lets a tab opened later join the unsaved buffer', () => {
    const a = openTab(store, 'wt-1')
    store.getState().setEditorDraft(a, 'typed in A')
    store.getState().markFileDirty(a, true)

    const b = openTab(store, 'wt-2')

    expect(store.getState().editorDrafts[b]).toBe('typed in A')
    expect(tab(store, b)?.isDirty).toBe(true)
  })

  it('clears every tab when either one saves, writing once at a time', async () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    store.getState().setEditorDraft(a, 'typed in A')
    store.getState().markFileDirty(a, true)
    const queue = createEditorSaveQueue(store)

    await Promise.all([
      queue.queueSave(tab(store, b)!, 'typed in A', 'user'),
      queue.queueSave(tab(store, a)!, 'typed in A', 'user')
    ])
    queue.dispose()

    expect(disk.files.get(FILE)).toBe('typed in A')
    expect(store.getState().editorDrafts).toEqual({})
    expect([tab(store, a)?.isDirty, tab(store, b)?.isDirty]).toEqual([false, false])
    expect(tab(store, a)?.lastKnownDiskSignature).toBe(tab(store, b)?.lastKnownDiskSignature)
  })

  it('marks every tab when the file changes on disk', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')

    store.getState().setExternalMutation(b, 'changed')

    expect(tab(store, a)?.externalMutation).toBe('changed')
  })

  it('persists the shared draft for every tab so hot exit restores each', () => {
    const a = openTab(store, 'wt-1')
    const b = openTab(store, 'wt-2')
    store.getState().setEditorDraft(a, 'typed in A')
    store.getState().markFileDirty(a, true)
    const state = store.getState()

    const session = buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})

    expect(session.openFilesByWorktree?.['wt-1']?.[0]?.dirtyDraftContent).toBe('typed in A')
    expect(session.openFilesByWorktree?.['wt-2']?.[0]?.dirtyDraftContent).toBe('typed in A')
    expect(getSameBufferFileIds(state, b)).toEqual([b, a])
  })

  it('keeps one tab (shown in split panes) on its own buffer', () => {
    const a = openTab(store, 'wt-1')
    expect(getSameBufferFileIds(store.getState(), a)).toEqual([a])
  })

  it('keeps the same path on another host separate', () => {
    const a = openTab(store, 'wt-1')
    const remote = openTab(store, 'wt-ssh')

    store.getState().setEditorDraft(a, 'typed in A')
    store.getState().markFileDirty(a, true)
    store.getState().setExternalMutation(a, 'changed')

    expect(getSameBufferFileIds(store.getState(), a)).toEqual([a])
    expect(store.getState().editorDrafts[remote]).toBeUndefined()
    expect(tab(store, remote)).toMatchObject({ isDirty: false })
    expect(tab(store, remote)?.externalMutation).toBeUndefined()
  })
})
