import type { OpenFile } from '../types/open-file'
import type { EditorBufferIdentity } from './editor-buffer-identity'

/**
 * Source of truth for the buffer state of one physical file, shared by every edit tab showing it.
 * The same fields on each tab are a mirror written in the same store update.
 */
export type EditorBufferRecord = Pick<
  OpenFile,
  | 'isDirty'
  | 'lastKnownDiskSignature'
  | 'externalMutation'
  | 'pendingDiskBaselineVerification'
  | 'pendingLiveDiskVerification'
  | 'pendingOwnerMigration'
>

export type EditorBufferRecords = Record<string, EditorBufferRecord>

export type EditorBufferKey = {
  identity: EditorBufferIdentity
  /** Fixed per record: a record kept apart from a same-file record gets its own model. */
  modelOwnerKey: string
}

export type EditorBufferIndex = {
  recordIdByFileId: Record<string, string>
  /** Only records that can be shared; the rest belong to one tab. */
  keyByRecordId: Record<string, EditorBufferKey>
}

export const EMPTY_EDITOR_BUFFER_INDEX: EditorBufferIndex = {
  recordIdByFileId: {},
  keyByRecordId: {}
}

type EditorBufferIndexState = { editorBufferIndex?: EditorBufferIndex }

/** A tab without an index entry (fixtures, a store without sharing) owns a record under its id. */
export function editorBufferIdOf(state: EditorBufferIndexState, fileId: string): string {
  return state.editorBufferIndex?.recordIdByFileId[fileId] ?? fileId
}

/** Every open tab sharing `fileId`'s record, `fileId` first. */
export function editorBufferViewIds(
  state: EditorBufferIndexState & { openFiles: readonly OpenFile[] },
  fileId: string
): string[] {
  const recordId = editorBufferIdOf(state, fileId)
  const ids = [fileId]
  for (const file of state.openFiles) {
    if (file.id !== fileId && editorBufferIdOf(state, file.id) === recordId) {
      ids.push(file.id)
    }
  }
  return ids
}

export const EDITOR_BUFFER_FIELDS = [
  'isDirty',
  'lastKnownDiskSignature',
  'externalMutation',
  'pendingDiskBaselineVerification',
  'pendingLiveDiskVerification',
  'pendingOwnerMigration'
] as const satisfies readonly (keyof EditorBufferRecord)[]

export function editorBufferRecordFromFile(file: OpenFile): EditorBufferRecord {
  return {
    isDirty: file.isDirty,
    lastKnownDiskSignature: file.lastKnownDiskSignature,
    externalMutation: file.externalMutation,
    pendingDiskBaselineVerification: file.pendingDiskBaselineVerification,
    pendingLiveDiskVerification: file.pendingLiveDiskVerification,
    pendingOwnerMigration: file.pendingOwnerMigration
  }
}

/** The file's record; a missing one is seeded from the tab, never from defaults. */
export function editorBufferOf(
  records: EditorBufferRecords,
  file: OpenFile,
  recordId = file.id
): EditorBufferRecord {
  return records[recordId] ?? editorBufferRecordFromFile(file)
}

export function editorBufferMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord
): keyof EditorBufferRecord | null {
  return EDITOR_BUFFER_FIELDS.find((field) => !Object.is(file[field], record[field])) ?? null
}

/** Writes `patch` to one file's record and every tab mirroring it in one update. */
export function writeEditorBuffer(
  state: EditorBufferIndexState & { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords },
  fileId: string,
  patch: Partial<EditorBufferRecord>,
  tabPatch?: Partial<OpenFile>
): { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords } {
  const recordId = editorBufferIdOf(state, fileId)
  let editorBuffers = state.editorBuffers
  const openFiles = state.openFiles.map((file) => {
    if (file.id !== fileId && editorBufferIdOf(state, file.id) !== recordId) {
      return file
    }
    if (editorBuffers === state.editorBuffers) {
      editorBuffers = {
        ...editorBuffers,
        [recordId]: { ...editorBufferOf(editorBuffers, file, recordId), ...patch }
      }
    }
    return { ...file, ...(file.id === fileId ? tabPatch : undefined), ...patch }
  })
  return { openFiles, editorBuffers }
}

/** (Re)creates records for tabs whose buffer state comes from outside the store, e.g. a host snapshot. */
export function createEditorBuffers(
  records: EditorBufferRecords,
  files: readonly OpenFile[],
  state: EditorBufferIndexState = {}
): EditorBufferRecords {
  if (files.length === 0) {
    return records
  }
  const next = { ...records }
  for (const file of files) {
    next[editorBufferIdOf(state, file.id)] = editorBufferRecordFromFile(file)
  }
  return next
}

/**
 * Points each migrated tab at its record under its new id. A patched tab whose record other tabs
 * keep showing splits off; sharing then decides whether it may join again.
 */
export function rekeyEditorBuffers(
  state: EditorBufferIndexState & { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords },
  migrations: ReadonlyMap<string, string>,
  patchFor?: (file: OpenFile) => Partial<EditorBufferRecord> | undefined
): Pick<Required<EditorBufferIndexState>, 'editorBufferIndex'> & {
  editorBuffers: EditorBufferRecords
} {
  const index = state.editorBufferIndex ?? EMPTY_EDITOR_BUFFER_INDEX
  const moved = state.openFiles.filter((file) => migrations.has(file.id))
  if (moved.length === 0) {
    return { editorBuffers: state.editorBuffers, editorBufferIndex: index }
  }
  const recordIdByFileId = { ...index.recordIdByFileId }
  const editorBuffers = { ...state.editorBuffers }
  // Why two passes: a swap of two ids must not delete the entry it just wrote.
  for (const file of moved) {
    delete recordIdByFileId[file.id]
  }
  for (const file of moved) {
    const newId = migrations.get(file.id) ?? file.id
    const patch = patchFor?.(file)
    let recordId = editorBufferIdOf(state, file.id)
    const shared = state.openFiles.some(
      (other) => !migrations.has(other.id) && editorBufferIdOf(state, other.id) === recordId
    )
    const record = editorBufferOf(state.editorBuffers, file, recordId)
    if (patch && shared) {
      recordId = newId
      for (let n = 1; recordId in editorBuffers; n += 1) {
        recordId = `${newId}#${n}`
      }
    }
    recordIdByFileId[newId] = recordId
    editorBuffers[recordId] = { ...record, ...editorBuffers[recordId], ...patch }
  }
  return { editorBuffers, editorBufferIndex: { ...index, recordIdByFileId } }
}
