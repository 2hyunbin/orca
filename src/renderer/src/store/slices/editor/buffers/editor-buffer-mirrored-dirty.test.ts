import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import { assertEditorBufferRecordsMatchViews } from '../../../editor-buffer-record-lifecycle'
import {
  adoptMirroredEditorBuffers,
  editorBufferRecordFromFile,
  type EditorBufferRecords
} from './editor-buffer-record'
import type { EditorBufferViewIndex } from './editor-buffer-views'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    mirroredFromRuntimeSession: true,
    ...patch
  }
}

/** Two host-owned views of one record, as the sharing switch will produce. */
const SHARED: EditorBufferViewIndex = {
  editorBufferIdOf: { a: 'rec', b: 'rec' },
  editorBufferViews: { rec: ['a', 'b'] }
}

describe('mirrored editor buffer dirty state', () => {
  it.each([
    [false, true],
    [true, false]
  ])('keeps the record dirty while any host-owned view is (a=%s, b=%s)', (aDirty, bDirty) => {
    const records: EditorBufferRecords = { rec: editorBufferRecordFromFile(tab('a')) }
    const openFiles = [tab('a', { isDirty: aDirty }), tab('b', { isDirty: bDirty })]

    expect(adoptMirroredEditorBuffers(records, openFiles, SHARED).rec?.isDirty).toBe(true)
  })

  it('clears the record once every host-owned view reads clean', () => {
    const records: EditorBufferRecords = {
      rec: editorBufferRecordFromFile(tab('a', { isDirty: true }))
    }
    expect(adoptMirroredEditorBuffers(records, [tab('a'), tab('b')], SHARED).rec?.isDirty).toBe(
      false
    )
  })

  it('returns the same records when the host published nothing new', () => {
    const openFiles = [tab('a', { isDirty: true }), tab('b')]
    const records: EditorBufferRecords = { rec: editorBufferRecordFromFile(openFiles[0]) }
    expect(adoptMirroredEditorBuffers(records, openFiles, SHARED)).toBe(records)
  })

  it('tolerates a host-owned view reading clean on a dirty record, and nothing else', () => {
    const record = editorBufferRecordFromFile(tab('a', { isDirty: true }))
    const check = (b: OpenFile): void =>
      assertEditorBufferRecordsMatchViews({
        ...SHARED,
        openFiles: [tab('a', { isDirty: true }), b],
        editorBuffers: { rec: record }
      })

    expect(() => check(tab('b'))).not.toThrow()
    expect(() => check(tab('b', { mirroredFromRuntimeSession: undefined }))).toThrow(
      /"isDirty" of b/
    )
    expect(() => check(tab('b', { externalMutation: 'changed' }))).toThrow(
      /"externalMutation" of b/
    )
  })

  it('does not tolerate a clean host-owned view when no other host-owned view reads dirty', () => {
    const record = editorBufferRecordFromFile(tab('a', { isDirty: true }))
    expect(() =>
      assertEditorBufferRecordsMatchViews({
        editorBufferIdOf: { a: 'rec' },
        editorBufferViews: { rec: ['a'] },
        openFiles: [tab('a')],
        editorBuffers: { rec: record }
      })
    ).toThrow(/"isDirty" of a/)
  })
})
