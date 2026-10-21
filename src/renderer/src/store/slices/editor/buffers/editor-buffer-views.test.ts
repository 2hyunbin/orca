import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand'
import { useAppStore } from '@/store'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'
import { createEditorDraftState } from '../actions/editor-draft-state'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { OpenFile } from '../types/open-file'
import {
  editorBufferRecordFromFile,
  writeEditorBuffer,
  type EditorBufferState
} from './editor-buffer-record'
import {
  EMPTY_EDITOR_BUFFER_VIEW_INDEX,
  reconcileEditorBufferViewIndex,
  type EditorBufferViewIndex
} from './editor-buffer-views'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/repo/${id}`,
    relativePath: id,
    worktreeId: 'wt-1',
    language: 'text',
    isDirty: false,
    mode: 'edit',
    ...patch
  }
}

function openEditTab(filePath: string, worktreeId = 'wt-1'): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/repo/'.length),
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'typescript',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

/** Two views of one record, as the sharing switch will produce. */
const SHARED: EditorBufferViewIndex = {
  editorBufferIdOf: { a: 'rec', b: 'rec', c: 'c' },
  editorBufferViews: { rec: ['a', 'b'], c: ['c'] }
}

describe('editor buffer view index', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('maps each tab to its own record through open, rekey and close', () => {
    const a = openEditTab('/repo/a.ts')
    const b = openEditTab('/repo/a.ts', 'wt-2')
    let state = useAppStore.getState()
    expect(state.editorBufferIdOf).toEqual({ [a]: a, [b]: b })
    expect(state.editorBufferViews).toEqual({ [a]: [a], [b]: [b] })

    state.rekeyOpenFilesForPathChange({
      rekeys: [
        {
          oldFileId: a,
          newFileId: '/repo/z.ts',
          oldFilePath: '/repo/a.ts',
          newFilePath: '/repo/z.ts',
          newRelativePath: 'z.ts'
        }
      ]
    })
    state = useAppStore.getState()
    expect(state.editorBufferIdOf).toEqual({ '/repo/z.ts': '/repo/z.ts', [b]: b })

    state.closeFile(b)
    state.closeFile('/repo/z.ts')
    expect(useAppStore.getState().editorBufferIdOf).toEqual({})
    expect(useAppStore.getState().editorBufferViews).toEqual({})
  })

  it('keeps the same index objects when a write does not change membership', () => {
    const id = openEditTab('/repo/a.ts')
    const before = useAppStore.getState()

    before.markFileDirty(id, true)
    before.setEditorDraft(id, 'edited')

    const after = useAppStore.getState()
    expect(after.editorBufferIdOf).toBe(before.editorBufferIdOf)
    expect(after.editorBufferViews).toBe(before.editorBufferViews)
    const files = [tab('a'), tab('b')]
    const index = reconcileEditorBufferViewIndex(EMPTY_EDITOR_BUFFER_VIEW_INDEX, files)
    expect(reconcileEditorBufferViewIndex(index, [...files])).toBe(index)
  })

  it('writes a buffer field to one tab only, as before', () => {
    const files = [tab('a'), tab('b')]
    const state = {
      openFiles: files,
      editorBuffers: {
        a: editorBufferRecordFromFile(files[0]),
        b: editorBufferRecordFromFile(files[1])
      },
      ...reconcileEditorBufferViewIndex(EMPTY_EDITOR_BUFFER_VIEW_INDEX, files)
    }

    const next = writeEditorBuffer(state, 'a', { isDirty: true }, { isPreview: false })

    expect(next.openFiles[0]).toMatchObject({ isDirty: true, isPreview: false })
    expect(next.openFiles[1]).toBe(files[1])
    expect(next.editorBuffers.b).toBe(state.editorBuffers.b)
  })

  it('writes a record and every view mirror once views share it', () => {
    const files = [tab('a'), tab('b'), tab('c')]
    const state = {
      openFiles: files,
      editorBuffers: {
        rec: editorBufferRecordFromFile(files[0]),
        c: editorBufferRecordFromFile(files[2])
      },
      ...SHARED
    }

    const next = writeEditorBuffer(state, 'b', { isDirty: true }, { isPreview: false })

    expect(next.editorBuffers.rec?.isDirty).toBe(true)
    expect(next.openFiles.map((file) => file.isDirty)).toEqual([true, true, false])
    expect(next.openFiles.map((file) => file.isPreview)).toEqual([undefined, false, undefined])
    expect(() =>
      assertEditorBufferInvariant({ ...next, ...SHARED, editorBufferViews: undefined })
    ).not.toThrow()
  })

  it('writes and clears drafts through every view of the record', () => {
    const store = createStore<EditorBufferState>()(() => ({
      openFiles: [tab('a'), tab('b'), tab('c'), tab('ro', { readOnly: true })],
      editorBuffers: {},
      editorDrafts: {},
      ...SHARED
    }))
    const drafts = createEditorDraftState(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the draft actions read and write only openFiles, editorDrafts and the view index.
      store.setState as unknown as EditorSet,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; the draft actions never call get.
      store.getState as unknown as EditorGet
    )

    drafts.setEditorDraft('a', 'shared')
    drafts.setEditorDraft('c', 'own')
    drafts.setEditorDraft('ro', 'refused')
    expect(store.getState().editorDrafts).toEqual({ a: 'shared', b: 'shared', c: 'own' })

    drafts.clearEditorDraft('b')
    expect(store.getState().editorDrafts).toEqual({ c: 'own' })
    drafts.setEditorDraft('a', 'again')
    drafts.clearEditorDrafts(['c', 'a'])
    expect(store.getState().editorDrafts).toEqual({})
  })

  it('writes and clears one tab draft when each tab has its own record, as before', () => {
    const a = openEditTab('/repo/a.ts')
    const b = openEditTab('/repo/a.ts', 'wt-2')

    useAppStore.getState().setEditorDraft(a, 'edited')
    expect(useAppStore.getState().editorDrafts).toEqual({ [a]: 'edited' })
    useAppStore.getState().setEditorDraft(b, 'other')
    useAppStore.getState().clearEditorDraft(a)
    expect(useAppStore.getState().editorDrafts).toEqual({ [b]: 'other' })
  })
})

describe('editor buffer invariant', () => {
  const files = [tab('a'), tab('b'), tab('c')]
  const valid = {
    openFiles: files,
    editorBuffers: {
      rec: editorBufferRecordFromFile(files[0]),
      c: editorBufferRecordFromFile(files[2])
    },
    editorDrafts: { a: 'x', b: 'x' },
    ...SHARED
  }
  // Only the record checks apply: the live key function still gives each tab its own record.
  const shared = { ...valid, editorBufferViews: undefined }

  it('accepts views that agree with their shared record', () => {
    expect(() => assertEditorBufferInvariant(shared)).not.toThrow()
  })

  it('rejects views of one record holding different drafts', () => {
    expect(() =>
      assertEditorBufferInvariant({
        ...shared,
        editorDrafts: { a: 'x', b: 'y' }
      })
    ).toThrow(/draft of b/)
  })

  it('rejects a view whose mirror differs from its shared record', () => {
    expect(() =>
      assertEditorBufferInvariant({
        ...shared,
        openFiles: [files[0], { ...files[1], isDirty: true }, files[2]]
      })
    ).toThrow(/"isDirty" of b/)
  })

  it('rejects a record with no view and an index that misses a tab', () => {
    expect(() =>
      assertEditorBufferInvariant({
        ...shared,
        editorBuffers: { ...valid.editorBuffers, orphan: valid.editorBuffers.c }
      })
    ).toThrow(/not keyed/)
    expect(() =>
      assertEditorBufferInvariant({
        openFiles: files,
        editorBuffers: {},
        ...EMPTY_EDITOR_BUFFER_VIEW_INDEX
      })
    ).toThrow(/view index/)
  })
})
