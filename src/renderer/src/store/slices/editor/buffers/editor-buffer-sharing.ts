import type { OpenFile } from '../types/open-file'
import {
  editorBufferMirrorMismatch,
  editorBufferRecordFromFile,
  type EditorBufferIndex,
  type EditorBufferKey,
  type EditorBufferRecord,
  type EditorBufferRecords
} from './editor-buffer-record'
import { isSameEditorBuffer, type EditorBufferIdentity } from './editor-buffer-identity'

export type EditorBufferSharingInput = {
  openFiles: OpenFile[]
  records: EditorBufferRecords
  index: EditorBufferIndex
  drafts: Record<string, string>
  /** Records as they stood before this write; a record replaced by the write is the truth. */
  previousRecords: EditorBufferRecords
  /** Tabs as they stood before this write; an unchanged tab keeps its record without a lookup. */
  previousFiles: ReadonlyMap<string, OpenFile> | null
  identityOf: (file: OpenFile) => EditorBufferIdentity | null
  /** Called for a tab mirror written without its record; returning keeps the tab's values. */
  onMirrorDrift: (file: OpenFile, field: keyof EditorBufferRecord) => void
}

export type EditorBufferSharingResult = {
  openFiles: OpenFile[]
  records: EditorBufferRecords
  index: EditorBufferIndex
  drafts: Record<string, string>
}

function hasEdits(record: EditorBufferRecord, draft: string | undefined): boolean {
  return record.isDirty || draft !== undefined
}

// Why OR: any tab's restore check or owner move must keep pausing autosave for the shared file.
function joinPauses(into: EditorBufferRecord, from: EditorBufferRecord): EditorBufferRecord {
  return {
    ...into,
    pendingDiskBaselineVerification:
      into.pendingDiskBaselineVerification || from.pendingDiskBaselineVerification || undefined,
    pendingLiveDiskVerification:
      into.pendingLiveDiskVerification || from.pendingLiveDiskVerification || undefined,
    pendingOwnerMigration: into.pendingOwnerMigration || from.pendingOwnerMigration || undefined
  }
}

/**
 * Keeps one record per physical file across every edit tab that shows it, in the same write that
 * changes the tabs. A tab that opens, re-keys or resolves its owner joins the record for its file:
 * the side with unsaved edits wins, and two sides whose edits differ stay apart (with their own
 * model) until there is a way to pick one. Read-only is a view permission, so it shares too.
 */
export function reconcileEditorBufferSharing(
  input: EditorBufferSharingInput
): EditorBufferSharingResult {
  const { openFiles, previousFiles, identityOf } = input
  const records = { ...input.records }
  const recordIdByFileId: Record<string, string> = {}
  const keyByRecordId: Record<string, EditorBufferKey> = { ...input.index.keyByRecordId }
  const drafts = { ...input.drafts }
  const viewsByRecord = new Map<string, string[]>()
  let draftsChanged = false

  const claim = (fileId: string, recordId: string): void => {
    recordIdByFileId[fileId] = recordId
    const views = viewsByRecord.get(recordId)
    if (views) {
      views.push(fileId)
    } else {
      viewsByRecord.set(recordId, [fileId])
    }
  }
  const setDraft = (fileId: string, draft: string | undefined): void => {
    if (drafts[fileId] === draft) {
      return
    }
    draftsChanged = true
    if (draft === undefined) {
      delete drafts[fileId]
    } else {
      drafts[fileId] = draft
    }
  }
  const freshRecordId = (fileId: string): string => {
    let recordId = fileId
    for (let n = 1; recordId in records; n += 1) {
      recordId = `${fileId}#${n}`
    }
    return recordId
  }

  // Pass 1: tabs whose record still describes their file keep it.
  const pending: {
    file: OpenFile
    identity: EditorBufferIdentity | null
    state: EditorBufferRecord
  }[] = []
  for (const file of openFiles) {
    const recordId = input.index.recordIdByFileId[file.id]
    let record = recordId === undefined ? undefined : records[recordId]
    if (recordId !== undefined && record !== undefined) {
      const field = editorBufferMirrorMismatch(file, record)
      if (field !== null && record === input.previousRecords[recordId]) {
        input.onMirrorDrift(file, field)
        record = editorBufferRecordFromFile(file)
        records[recordId] = record
      }
      if (previousFiles?.get(file.id) === file) {
        claim(file.id, recordId)
        continue
      }
      const identity = identityOf(file)
      const key = keyByRecordId[recordId]
      if (identity === null ? key === undefined : key?.identity.key === identity.key) {
        claim(file.id, recordId)
        continue
      }
      pending.push({ file, identity, state: record })
      continue
    }
    pending.push({ file, identity: identityOf(file), state: editorBufferRecordFromFile(file) })
  }

  // Pass 2: new tabs and tabs whose file changed find or create their record.
  for (const { file, identity, state } of pending) {
    const ownRecordId = input.index.recordIdByFileId[file.id] ?? file.id
    const target =
      identity === null ? undefined : findSharedRecord(keyByRecordId, viewsByRecord, identity)
    if (target !== undefined) {
      const targetRecord = records[target.id]
      const draft = drafts[file.id]
      const targetDraft = drafts[target.views[0]]
      const viewEdited = hasEdits(state, draft)
      const targetEdited = hasEdits(targetRecord, targetDraft)
      // Why: until a recovery UI exists, two different unsaved edits of one file both stay intact.
      if (!(viewEdited && targetEdited && draft !== targetDraft)) {
        records[target.id] =
          viewEdited && !targetEdited
            ? joinPauses(state, targetRecord)
            : joinPauses(targetRecord, state)
        if (viewEdited && !targetEdited) {
          for (const viewId of target.views) {
            setDraft(viewId, draft)
          }
        } else {
          setDraft(file.id, targetDraft)
        }
        claim(file.id, target.id)
        continue
      }
    }

    const recordId =
      ownRecordId in records && !viewsByRecord.has(ownRecordId)
        ? ownRecordId
        : freshRecordId(file.id)
    records[recordId] = state
    if (identity === null) {
      delete keyByRecordId[recordId]
    } else {
      // Why: a same-file record kept apart (divergent edits, a retired host) holds the default URI.
      const uriTaken = Object.entries(keyByRecordId).some(
        ([otherId, key]) =>
          otherId !== recordId &&
          viewsByRecord.has(otherId) &&
          key.identity.key === identity.key &&
          key.modelOwnerKey === identity.modelOwnerKey
      )
      keyByRecordId[recordId] = {
        identity,
        modelOwnerKey: uriTaken
          ? JSON.stringify([identity.modelOwnerKey, 'record', recordId])
          : identity.modelOwnerKey
      }
    }
    claim(file.id, recordId)
  }

  for (const recordId of Object.keys(records)) {
    if (!viewsByRecord.has(recordId)) {
      delete records[recordId]
      delete keyByRecordId[recordId]
    }
  }
  for (const recordId of Object.keys(keyByRecordId)) {
    if (!(recordId in records)) {
      delete keyByRecordId[recordId]
    }
  }

  // Why: a split lasts only while both sides hold unsaved edits; a clean side rejoins its file.
  for (const [recordId, key] of Object.entries(keyByRecordId)) {
    const views = viewsByRecord.get(recordId)
    const record = records[recordId]
    if (views === undefined || hasEdits(record, drafts[views[0]])) {
      continue
    }
    const target = findSharedRecord(keyByRecordId, viewsByRecord, key.identity, recordId)
    const targetEdited =
      target !== undefined && hasEdits(records[target.id], drafts[target.views[0]])
    // Two clean sides: the one holding the default model stays and the other joins it. A clean
    // side adopts the other side's edits only when both start from the same disk version, so a
    // just-saved tab never swaps its text for a draft made against older disk.
    if (
      target === undefined ||
      (key.modelOwnerKey === key.identity.modelOwnerKey && !targetEdited) ||
      (targetEdited && records[target.id].lastKnownDiskSignature !== record.lastKnownDiskSignature)
    ) {
      continue
    }
    records[target.id] = joinPauses(records[target.id], record)
    for (const viewId of views) {
      setDraft(viewId, drafts[target.views[0]])
      claim(viewId, target.id)
    }
    viewsByRecord.delete(recordId)
    delete records[recordId]
    delete keyByRecordId[recordId]
  }

  return {
    // Unchanged tabs keep their identity; the caller keeps the list when none changed.
    openFiles: openFiles.map((file) => {
      const record = records[recordIdByFileId[file.id]]
      return editorBufferMirrorMismatch(file, record) === null ? file : { ...file, ...record }
    }),
    records: sameKeysAndValues(records, input.records) ? input.records : records,
    index: sameIndex(recordIdByFileId, keyByRecordId, input.index)
      ? input.index
      : { recordIdByFileId, keyByRecordId },
    drafts: draftsChanged ? drafts : input.drafts
  }
}

function findSharedRecord(
  keyByRecordId: Record<string, EditorBufferKey>,
  viewsByRecord: ReadonlyMap<string, string[]>,
  identity: EditorBufferIdentity,
  excludeId?: string
): { id: string; views: string[] } | undefined {
  let found: { id: string; views: string[] } | undefined
  for (const [id, key] of Object.entries(keyByRecordId)) {
    const views = viewsByRecord.get(id)
    if (id === excludeId || views === undefined || !isSameEditorBuffer(key.identity, identity)) {
      continue
    }
    // The record holding the default model wins over one kept apart from it.
    if (key.modelOwnerKey === identity.modelOwnerKey) {
      return { id, views }
    }
    found ??= { id, views }
  }
  return found
}

function sameKeysAndValues<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}

function sameIndex(
  recordIdByFileId: Record<string, string>,
  keyByRecordId: Record<string, EditorBufferKey>,
  index: EditorBufferIndex
): boolean {
  return (
    sameKeysAndValues(recordIdByFileId, index.recordIdByFileId) &&
    sameKeysAndValues(keyByRecordId, index.keyByRecordId)
  )
}
