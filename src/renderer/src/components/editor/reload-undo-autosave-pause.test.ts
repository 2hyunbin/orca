// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { toEditorModelUri } from './editor-model-uri'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { replaceModelContentAsUndoStep } from './monaco-content-sync'
import { watchReloadUndoBoundary } from './reload-undo-autosave-pause'

const holder = vi.hoisted(() => {
  const value: { store: { getState: () => unknown } | null } = { store: null }
  return value
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => holder.store?.getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const FILE_ID = '/repo/file.ts'
const MODEL_KEY = toEditorModelUri(FILE_ID)

describe('autosave pause after undoing past a reload', () => {
  let model: monaco.editor.ITextModel
  let store: ReturnType<typeof createEditorStore>
  let writeFile: ReturnType<typeof vi.fn>
  let cleanup: () => void

  function type(text: string): void {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  }

  async function autosaveWrites(): Promise<string[]> {
    writeFile.mockClear()
    await vi.advanceTimersByTimeAsync(1500)
    return writeFile.mock.calls.map(([request]) => request.content)
  }

  function pausedTabIds(): string[] {
    return store
      .getState()
      .openFiles.filter((file) => file.autosavePausedAfterReloadUndo !== undefined)
      .map((file) => file.id)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    model = monaco.editor.createModel('user draft', 'plaintext', monaco.Uri.parse(MODEL_KEY))
    writeFile = stubEditorWindow()
    store = createEditorStore()
    holder.store = store
    store.getState().openFile({
      filePath: FILE_ID,
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    cleanup = attachEditorAutosaveController(store)
    // Why: stands in for the editor bridge, which records each change as the draft before
    // any later listener (the boundary watch) runs.
    model.onDidChangeContent(() => {
      store.getState().setEditorDraft(FILE_ID, model.getValue())
      store.getState().markFileDirty(FILE_ID, model.getValue() !== 'agent text')
    })
    // The banner reload: one undoable edit to the agent's text, tab clean.
    replaceModelContentAsUndoStep(model, 'agent text')
    store.getState().markFileDirty(FILE_ID, false)
    watchReloadUndoBoundary(model, MODEL_KEY)
  })

  afterEach(() => {
    cleanup()
    model.dispose()
    holder.store = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('autosave never writes undone-reload text; an explicit save does', async () => {
    type('agent text, then typing')
    // Why: an autosave between the typing and the undo must not clear the boundary.
    expect(await autosaveWrites()).toEqual(['agent text, then typing'])

    await model.undo()
    await model.undo()
    expect(model.getValue()).toBe('user draft')
    expect(await autosaveWrites()).toEqual([])
    expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()

    writeFile.mockClear()
    await requestEditorFileSave({ fileId: FILE_ID })
    expect(writeFile.mock.calls.map(([request]) => request.content)).toEqual(['user draft'])
    expect(pausedTabIds()).toEqual([])
  })

  it('redo back across the reload resumes and reschedules autosave', async () => {
    type('agent text, then typing')
    await model.undo()
    await model.undo()
    await model.redo()
    expect(model.getValue()).toBe('agent text')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)

    await model.redo()
    expect(await autosaveWrites()).toEqual(['agent text, then typing'])
  })

  it('crossing the boundary again after an explicit save pauses again', async () => {
    await model.undo()
    await requestEditorFileSave({ fileId: FILE_ID })
    await model.redo()
    await model.undo()

    expect(pausedTabIds()).toEqual([FILE_ID])
    expect(await autosaveWrites()).toEqual([])
  })

  it('a save in flight does not resume a pause created during its write', async () => {
    await model.undo()
    let finishWrite: () => void = () => undefined
    writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    const save = requestEditorFileSave({ fileId: FILE_ID })
    await vi.advanceTimersByTimeAsync(0)
    await model.redo()
    await model.undo()
    finishWrite()
    await save

    expect(pausedTabIds()).toEqual([FILE_ID])
  })

  it('pauses every tab that shares the model', async () => {
    store.setState((state) => ({
      openFiles: state.openFiles.flatMap((file) => [
        file,
        { ...file, id: 'same-file-other-workspace' }
      ])
    }))

    await model.undo()

    expect(pausedTabIds()).toEqual([FILE_ID, 'same-file-other-workspace'])
  })

  it('a disk change after the undo raises the normal conflict', async () => {
    await model.undo()
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
      })
    )

    expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    expect(store.getState().editorDrafts[FILE_ID]).toBe('user draft')
  })
})
