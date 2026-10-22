import type { OpenFile } from '../types/open-file'
import {
  editorBufferIdOfView,
  editorBufferViewIds,
  type EditorBufferViewIndex
} from './editor-buffer-views'

/**
 * Source of truth for a tab's buffer state, keyed by `OpenFile.id`. The same fields on
 * `OpenFile` are a mirror written in the same store update so existing readers keep working.
 */
export type EditorBufferRecord = Pick<
  OpenFile,
  'isDirty' | 'lastKnownDiskSignature' | 'externalMutation' | 'pendingOwnerMigration'
>

export type EditorBufferRecords = Record<string, EditorBufferRecord>

/** What a buffer write replaces. */
export type EditorBufferWrite = { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords }

export type EditorBufferState = EditorBufferWrite &
  EditorBufferViewIndex & { editorDrafts?: Record<string, string> }

export const EDITOR_BUFFER_FIELDS = [
  'isDirty',
  'lastKnownDiskSignature',
  'externalMutation',
  'pendingOwnerMigration'
] as const satisfies readonly (keyof EditorBufferRecord)[]

export function editorBufferRecordFromFile(file: OpenFile): EditorBufferRecord {
  return {
    isDirty: file.isDirty,
    lastKnownDiskSignature: file.lastKnownDiskSignature,
    externalMutation: file.externalMutation,
    pendingOwnerMigration: file.pendingOwnerMigration
  }
}

/** The file's record; a missing one is seeded from the tab, never from defaults. */
export function editorBufferOf(records: EditorBufferRecords, file: OpenFile): EditorBufferRecord {
  return records[file.id] ?? editorBufferRecordFromFile(file)
}

export function editorBufferMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord
): keyof EditorBufferRecord | null {
  return EDITOR_BUFFER_FIELDS.find((field) => !Object.is(file[field], record[field])) ?? null
}

/** Writes `patch` to the file's record and every view's mirror in one update; `tabPatch` lands on `fileId` only. */
export function writeEditorBuffer(
  state: EditorBufferState,
  fileId: string,
  patch: Partial<EditorBufferRecord>,
  tabPatch?: Partial<OpenFile>
): EditorBufferWrite {
  const recordId = editorBufferIdOfView(state, fileId)
  const viewIds = new Set(editorBufferViewIds(state, recordId))
  viewIds.add(fileId)
  let editorBuffers = state.editorBuffers
  const openFiles = state.openFiles.map((file) => {
    if (!viewIds.has(file.id)) {
      return file
    }
    if (editorBuffers === state.editorBuffers) {
      editorBuffers = {
        ...editorBuffers,
        [recordId]: { ...(editorBuffers[recordId] ?? editorBufferRecordFromFile(file)), ...patch }
      }
    }
    return file.id === fileId ? { ...file, ...tabPatch, ...patch } : { ...file, ...patch }
  })
  return { openFiles, editorBuffers }
}

/** Writes `patch` through the file's record; returns `state` itself when the record already holds it. */
export function updateEditorBuffer<TState extends EditorBufferState>(
  state: TState,
  fileId: string,
  patch: Partial<EditorBufferRecord>
): TState | EditorBufferWrite {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return state
  }
  const record = editorBufferOf(state.editorBuffers, file)
  const changes = EDITOR_BUFFER_FIELDS.some(
    (field) => Object.hasOwn(patch, field) && !Object.is(record[field], patch[field])
  )
  return changes ? writeEditorBuffer(state, fileId, patch) : state
}

/**
 * A host-mirrored tab carries the host's buffer state, so its record adopts it in the same write.
 * Dirty is the OR of the record's mirrored views: an older host publishes it per tab.
 */
export function adoptMirroredEditorBuffers(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[],
  index: EditorBufferViewIndex
): EditorBufferRecords {
  const adopted = new Map<string, EditorBufferRecord>()
  for (const file of openFiles) {
    const recordId = editorBufferIdOfView(index, file.id)
    if (file.mirroredFromRuntimeSession !== true || !records[recordId]) {
      continue
    }
    const prior = adopted.get(recordId)
    adopted.set(
      recordId,
      prior
        ? { ...prior, isDirty: prior.isDirty || file.isDirty }
        : editorBufferRecordFromFile(file)
    )
  }
  let next = records
  for (const [recordId, record] of adopted) {
    if (EDITOR_BUFFER_FIELDS.every((field) => Object.is(records[recordId][field], record[field]))) {
      continue
    }
    next = next === records ? { ...records } : next
    next[recordId] = record
  }
  return next
}

/**
 * A host-mirrored view may read clean while its record is dirty, but only because another
 * host-owned view of the record reads dirty: the record ORs per-tab host values.
 */
export function editorBufferViewMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord,
  hostSiblingDirty: boolean
): keyof EditorBufferRecord | null {
  const hostDirty = file.mirroredFromRuntimeSession === true && record.isDirty && hostSiblingDirty
  return editorBufferMirrorMismatch(hostDirty ? { ...file, isDirty: true } : file, record)
}

/** Moves each migrated tab's record to its new id in the same update that re-keys the tab. */
export function rekeyEditorBuffers(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[],
  migrations: ReadonlyMap<string, string>,
  patchFor?: (file: OpenFile) => Partial<EditorBufferRecord> | undefined
): EditorBufferRecords {
  const moved = openFiles.filter((file) => migrations.has(file.id))
  if (moved.length === 0) {
    return records
  }
  const next = { ...records }
  // Why two passes: a swap of two ids must not delete the record it just wrote.
  for (const file of moved) {
    delete next[file.id]
  }
  for (const file of moved) {
    next[migrations.get(file.id) ?? file.id] = {
      ...editorBufferOf(records, file),
      ...patchFor?.(file)
    }
  }
  return next
}

/** Keeps one record per record id of the open tabs: seeds a record from its first view, drops ones with no view. */
export function reconcileEditorBufferMembership(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[],
  index: EditorBufferViewIndex
): EditorBufferRecords {
  let next = records
  const ids = new Set<string>()
  for (const file of openFiles) {
    const recordId = editorBufferIdOfView(index, file.id)
    ids.add(recordId)
    if (!Object.hasOwn(next, recordId)) {
      next = next === records ? { ...records } : next
      next[recordId] = editorBufferRecordFromFile(file)
    }
  }
  for (const id of Object.keys(next)) {
    if (!ids.has(id)) {
      next = next === records ? { ...records } : next
      delete next[id]
    }
  }
  return next
}
