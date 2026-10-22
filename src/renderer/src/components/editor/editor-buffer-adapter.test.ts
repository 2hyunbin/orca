// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { createEditorModelRegistry } from '@/lib/editor-model-registry'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { requestKeepEditorBuffers } from '@/store/slices/editor/buffers/editor-buffer-kept'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { applyEditorBufferText, withRecordDiskText } from './editor-buffer-adapter'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { attachClosedEditorTabCleanup } from './closed-editor-tab-controller'
import { attachModelLifetimeView } from './editor-model-lifetime-fixture'

const PATH = '/repo/notes.md'
const bridge = createEditorModelRegistry()
bridge.register(monaco)

function twoViews(): { store: StoreApi<AppState>; a: string; b: string } {
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  for (const worktreeId of ['wt-1', 'wt-2']) {
    store.getState().openFile({
      filePath: PATH,
      relativePath: 'notes.md',
      worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
  }
  const [a, b] = store.getState().openFiles
  return { store, a: a.id, b: b.id }
}

function modelOf(
  store: StoreApi<AppState>,
  viewId: string,
  text = 'disk'
): monaco.editor.ITextModel {
  const state = store.getState()
  const file = state.openFiles.find((tab) => tab.id === viewId)!
  const uri = monaco.Uri.parse(editorTabModelUri(state, file))
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, 'markdown', uri)
}

const file = (store: StoreApi<AppState>, id: string) =>
  store.getState().openFiles.find((tab) => tab.id === id)!

afterEach(() => {
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

describe('applyEditorBufferText', () => {
  let store: StoreApi<AppState>
  let a: string
  let b: string
  beforeEach(() => {
    ;({ store, a, b } = twoViews())
    // `a` shows Monaco source; `b` keeps the rich view.
    store.getState().setMarkdownViewMode(a, 'source')
  })

  it("carries a rich commit into the record's model no editor shows, as one undoable edit", () => {
    const model = modelOf(store, a)
    applyEditorBufferText(store.getState(), file(store, b), 'rich edit', bridge)
    expect(model.getValue()).toBe('rich edit')
    model.undo()
    expect(model.getValue()).toBe('disk')
  })

  it('leaves a shown model to its editor and ignores commits from a code view', () => {
    const model = modelOf(store, a)
    const detach = attachModelLifetimeView(model)
    applyEditorBufferText(store.getState(), file(store, b), 'rich edit', bridge)
    expect(model.getValue()).toBe('disk')
    detach()
    applyEditorBufferText(store.getState(), file(store, a), 'typed in source', bridge)
    expect(model.getValue()).toBe('disk')
  })
})

describe('withRecordDiskText (panel content sync)', () => {
  it('moves every loaded view of the saved record to the written text, nothing else', () => {
    const { store, a, b } = twoViews()
    const prev = {
      [a]: { content: 'old', isBinary: false },
      [b]: { content: 'old', isBinary: false },
      other: { content: 'other', isBinary: false }
    }
    const next = withRecordDiskText(prev, store.getState(), a, 'saved')
    expect(next[b]?.content).toBe('saved')
    // The saver's own entry is written by the saved event itself.
    expect(next[a]?.content).toBe('old')
    expect(next.other?.content).toBe('other')
    expect(withRecordDiskText({ [a]: prev[a] }, store.getState(), a, 'saved')).toEqual({
      [a]: prev[a]
    })
  })
})

describe('a kept dirty record owns its model', () => {
  it('keeps the model past its last view until the record is released', async () => {
    const { store, a, b } = twoViews()
    store.setState((s) => ({ openFiles: s.openFiles.filter((tab) => tab.id !== b) }))
    store.getState().setEditorDraft(a, 'unsaved')
    store.getState().markFileDirty(a, true)
    const model = modelOf(store, a, 'unsaved')
    const detach = attachClosedEditorTabCleanup(store, bridge)
    try {
      store.setState((s) => {
        requestKeepEditorBuffers([a])
        return { openFiles: s.openFiles.filter((tab) => tab.id !== a) }
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(model.isDisposed()).toBe(false)

      store.getState().releaseKeptEditorBuffers([a])
      await Promise.resolve()
      await Promise.resolve()
      expect(model.isDisposed()).toBe(true)
    } finally {
      detach()
    }
  })
})
