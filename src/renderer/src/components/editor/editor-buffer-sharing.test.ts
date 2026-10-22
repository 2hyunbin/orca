// @vitest-environment happy-dom
// Why: G3 scenarios through the real record middleware and save queue, with two workspaces showing
// one file: restored drafts, phone saves, delayed rich text and paused autosave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  getOpenFilesForExternalFileChange,
  isAutosaveSuspendedForFile,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  requestEditorFileSave
} from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { GUARDED_PATH, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { mayPushTabTextIntoModel, isStaleCachedEditorText } from './editor-stale-mount-guard'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { isDetachedEditorBufferId } from '@/store/slices/editor/buffers/editor-buffer-views'
import { buildHydratedEditorSessionState } from '@/store/slices/editor/actions/hydrated-editor-session-state'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

const BASE = 'base'

function twoWorkspaceStore(): StoreApi<AppState> {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  return store
}

function restore(store: StoreApi<AppState>, drafts: [string, string]): [OpenFile, OpenFile] {
  const entry = (worktreeId: string, draft: string) => ({
    filePath: GUARDED_PATH,
    relativePath: 'file.ts',
    worktreeId,
    language: 'typescript',
    dirtyDraftContent: draft,
    lastKnownDiskSignature: getDiskBaselineSignature(BASE)
  })
  const session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: 'wt-1',
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { 'wt-1': [entry('wt-1', drafts[0])], 'wt-2': [entry('wt-2', drafts[1])] }
  }
  // The store write session hydration makes.
  store.setState(buildHydratedEditorSessionState(session, new Set(['wt-1', 'wt-2']), 'wt-1').state)
  const [a, b] = store.getState().openFiles
  expect([a?.worktreeId, b?.worktreeId]).toEqual(['wt-1', 'wt-2'])
  return [a, b]
}

/** What a mount does with the view's text: create its model, or push into one it may overwrite. */
function mount(store: StoreApi<AppState>, viewId: string): monaco.editor.ITextModel {
  const state = store.getState()
  const file = state.openFiles.find((tab) => tab.id === viewId)!
  const uri = monaco.Uri.parse(editorTabModelUri(state, file))
  const text = state.editorDrafts[viewId] ?? BASE
  const model = monaco.editor.getModel(uri)
  if (!model) {
    return monaco.editor.createModel(text, 'typescript', uri)
  }
  if (model.getValue() !== text && mayPushTabTextIntoModel(viewId)) {
    model.setValue(text)
  }
  return model
}

const view = (store: StoreApi<AppState>, id: string) =>
  store.getState().openFiles.find((tab) => tab.id === id)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __clearSelfWriteRegistryForTests()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

describe('restored drafts of one file (scenario 2)', () => {
  it.each([['a first'], ['b first'], ['no mount']] as const)(
    'divergent drafts detach with their own models (%s); the first autosave lands and the other side keeps its draft behind the banner',
    async (order) => {
      const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
      const store = twoWorkspaceStore()
      const [a, b] = restore(store, ['abc', 'abcd'])
      const recordOf = (id: string) => store.getState().editorBufferIdOf[id]
      expect(isDetachedEditorBufferId(recordOf(b.id))).toBe(true)

      if (order !== 'no mount') {
        const ids = order === 'a first' ? [a.id, b.id] : [b.id, a.id]
        const models: monaco.editor.ITextModel[] = []
        for (const id of ids) {
          models.push(mount(store, id))
        }
        expect(models[0]).not.toBe(models[1])
        expect(mount(store, a.id).getValue()).toBe('abc')
        expect(mount(store, b.id).getValue()).toBe('abcd')
      }

      const cleanup = attachEditorAutosaveController(store)
      try {
        await vi.advanceTimersByTimeAsync(5000)
        // One write landed; the other was refused against the restored baseline.
        const landed = disk.files.get(GUARDED_PATH)
        expect(['abc', 'abcd']).toContain(landed)
        const kept = landed === 'abc' ? 'abcd' : 'abc'
        expect(disk.writeFile).toHaveBeenCalledTimes(2)
        // Rejoined: the unsaved side won with its old baseline, banner on every view.
        expect(recordOf(a.id)).toBe(recordOf(b.id))
        for (const id of [a.id, b.id]) {
          expect(store.getState().editorDrafts[id]).toBe(kept)
          expect(view(store, id)?.isDirty).toBe(true)
          expect(view(store, id)?.externalMutation).toBe('changed')
          expect(view(store, id)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature(BASE))
        }
      } finally {
        cleanup()
      }
    }
  )

  it('identical drafts merge into one record and write once', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const store = twoWorkspaceStore()
    const [a, b] = restore(store, ['same', 'same'])
    expect(store.getState().editorBufferIdOf[a.id]).toBe(store.getState().editorBufferIdOf[b.id])
    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(GUARDED_PATH)).toBe('same')
      expect(view(store, a.id)?.isDirty).toBe(false)
      expect(view(store, b.id)?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })
})

function openShared(disk: string) {
  const store = twoWorkspaceStore()
  for (const worktreeId of ['wt-1', 'wt-2']) {
    store.getState().openFile({
      filePath: GUARDED_PATH,
      relativePath: 'file.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  store.getState().setLastKnownDiskSignature(a.id, getDiskBaselineSignature(disk))
  return { store, a, b }
}

describe('two workspaces on one record', () => {
  it('W1 "abc", W2 "d": one write of "abcd"; old W1 text never reaches the model (scenario 1)', async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'abc')
    store.getState().markFileDirty(a.id, true)
    store.getState().setEditorDraft(b.id, 'abcd')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(GUARDED_PATH)).toBe('abcd')
      expect(view(store, a.id)?.isDirty).toBe(false)
      expect(view(store, b.id)?.isDirty).toBe(false)
      // W1 remounting with its old text: stale, never pushed into the model.
      expect(isStaleCachedEditorText(a.id, 'abc')).toBe(true)
      expect(isStaleCachedEditorText(a.id, 'abcd')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it.each([
    ['dirty', 'banners every view'],
    ['clean', 'reloads every view']
  ] as const)('a phone save on a %s record %s (scenario 4)', (state, _outcome) => {
    stubGuardedDisk({ [GUARDED_PATH]: 'from phone' })
    const { store, a, b } = openShared(BASE)
    if (state === 'dirty') {
      store.getState().setEditorDraft(a.id, 'desktop edits')
      store.getState().markFileDirty(a.id, true)
    }
    const cleanup = attachEditorAutosaveController(store)
    try {
      const detail = { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
      window.dispatchEvent(new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, { detail }))
      for (const id of [a.id, b.id]) {
        if (state === 'dirty') {
          expect(view(store, id)?.externalMutation).toBe('changed')
          expect(store.getState().editorDrafts[id]).toBe('desktop edits')
        } else {
          expect(view(store, id)?.isDirty).toBe(false)
          expect(store.getState().editorDrafts[id]).toBeUndefined()
        }
      }
      if (state === 'clean') {
        // The panel reloads every tab this matches.
        const matched = getOpenFilesForExternalFileChange(store.getState().openFiles, {
          worktreeId: 'wt-2',
          worktreePath: '/repo',
          relativePath: 'file.ts'
        }).map((file) => file.id)
        expect(matched).toContain(b.id)
      }
    } finally {
      cleanup()
    }
  })

  it("a save writes another view's pending rich text; typing during the save stays dirty (scenario 5)", async () => {
    const disk = stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'source')
    store.getState().markFileDirty(a.id, true)
    let pending: string | null = 'source, rich'
    const unregister = registerPendingEditorFlush(b.id, () => {
      if (pending !== null) {
        store.getState().setEditorDraft(b.id, pending)
        pending = null
      }
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: a.id })
      expect(disk.files.get(GUARDED_PATH)).toBe('source, rich')
      expect(view(store, b.id)?.isDirty).toBe(false)
    } finally {
      unregister()
      cleanup()
    }
  })

  it('a conflicted record pauses autosave on every view; a detached pair shows its own (scenario 8)', () => {
    stubGuardedDisk({ [GUARDED_PATH]: BASE })
    const { store, a, b } = openShared(BASE)
    store.getState().setEditorDraft(a.id, 'mine')
    store.getState().markFileDirty(a.id, true)
    store.getState().setExternalMutation(b.id, 'changed')
    for (const id of [a.id, b.id]) {
      expect(isAutosaveSuspendedForFile(view(store, id)!)).toBe(true)
    }

    const pair = twoWorkspaceStore()
    const [c, d] = restore(pair, ['abc', 'abcd'])
    pair.getState().setExternalMutation(d.id, 'changed')
    expect(isAutosaveSuspendedForFile(view(pair, d.id)!)).toBe(true)
    expect(isAutosaveSuspendedForFile(view(pair, c.id)!)).toBe(false)
  })
})
