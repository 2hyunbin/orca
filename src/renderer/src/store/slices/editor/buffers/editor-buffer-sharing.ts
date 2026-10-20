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
import type { RecoveredEditorDraft } from '../../../../../../shared/workspace-session-state-types'

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
  /** Higher for a more recently active tab; its draft wins when two tabs' drafts differ. */
  draftPreference: (fileId: string) => number
  now: () => number
}

export type EditorBufferSharingResult = {
  openFiles: OpenFile[]
  records: EditorBufferRecords
  index: EditorBufferIndex
  drafts: Record<string, string>
  /** Drafts that lost a join, to be offered back to the user. */
  recovered: RecoveredEditorDraft[]
}

// Why a counter: drafts recovered in one join share a timestamp but each needs its own id.
let recoveredDraftSequence = 0

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
 * the side with unsaved edits wins. Two different drafts (only from an older session) keep the
 * most recently active tab's, and the other is kept as a recovered draft. Read-only is a view
 * permission, so it shares too.
 */
export function reconcileEditorBufferSharing(
  input: EditorBufferSharingInput
): EditorBufferSharingResult {
  const { openFiles, previousFiles, identityOf } = input
  const records = { ...input.records }
  const recordIdByFileId: Record<string, string> = {}
  const keyByRecordId: Record<string, EditorBufferKey> = { ...input.index.keyByRecordId }
  const drafts = { ...input.drafts }
  const recovered: RecoveredEditorDraft[] = []
  const viewsByRecord = new Map<string, string[]>()
  // Why an index: joins look up same-file records per tab, which must stay O(1) for many tabs.
  const idsByIdentityKey = new Map<string, string[]>()
  const indexIdentity = (recordId: string, identityKey: string): void => {
    const ids = idsByIdentityKey.get(identityKey)
    if (ids) {
      ids.push(recordId)
    } else {
      idsByIdentityKey.set(identityKey, [recordId])
    }
  }
  for (const [recordId, key] of Object.entries(keyByRecordId)) {
    indexIdentity(recordId, key.identity.key)
  }
  const sameFile = (identity: EditorBufferIdentity) =>
    findSharedRecord(
      (idsByIdentityKey.get(identity.key) ?? []).flatMap((id) => {
        const key = keyByRecordId[id]
        return key !== undefined ? [[id, key] as const] : []
      }),
      viewsByRecord,
      identity
    )
  let draftsChanged = false

  // The tab whose draft a record carries, so a draft that loses a later join is credited to it.
  const draftOwnerByRecord = new Map<string, OpenFile>()
  const filesById = new Map(openFiles.map((file) => [file.id, file]))
  const claim = (fileId: string, recordId: string): void => {
    recordIdByFileId[fileId] = recordId
    const owner = filesById.get(fileId)
    if (owner && !draftOwnerByRecord.has(recordId)) {
      draftOwnerByRecord.set(recordId, owner)
    }
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
    const target = identity === null ? undefined : sameFile(identity)
    if (target !== undefined) {
      const targetRecord = records[target.id]
      const draft = drafts[file.id]
      const targetDraft = drafts[target.views[0]]
      const viewEdited = hasEdits(state, draft)
      const targetEdited = hasEdits(targetRecord, targetDraft)
      const divergent = viewEdited && targetEdited && draft !== targetDraft
      const viewWins = divergent
        ? input.draftPreference(file.id) > Math.max(...target.views.map(input.draftPreference))
        : viewEdited && !targetEdited
      if (divergent) {
        const [loser, loserState, loserFile] = viewWins
          ? [targetDraft, targetRecord, draftOwnerByRecord.get(target.id) ?? file]
          : [draft, state, file]
        if (viewWins) {
          draftOwnerByRecord.set(target.id, file)
        }
        if (loser !== undefined) {
          recovered.push({
            filePath: loserFile.filePath,
            relativePath: loserFile.relativePath,
            worktreeId: loserFile.worktreeId,
            ...(loserFile.runtimeEnvironmentId !== undefined
              ? { runtimeEnvironmentId: loserFile.runtimeEnvironmentId }
              : {}),
            draft: loser,
            ...(loserState.lastKnownDiskSignature
              ? { baselineSignature: loserState.lastKnownDiskSignature }
              : {}),
            recoveredAt: input.now(),
            id: `${input.now()}:${(recoveredDraftSequence += 1)}`
          })
        }
      }
      records[target.id] = viewWins
        ? joinPauses(state, targetRecord)
        : joinPauses(targetRecord, state)
      if (viewWins) {
        for (const viewId of target.views) {
          setDraft(viewId, draft)
        }
      } else {
        setDraft(file.id, targetDraft)
      }
      claim(file.id, target.id)
      continue
    }

    const recordId =
      ownRecordId in records && !viewsByRecord.has(ownRecordId)
        ? ownRecordId
        : freshRecordId(file.id)
    records[recordId] = state
    if (identity === null) {
      delete keyByRecordId[recordId]
    } else {
      // Why: a same-path record on a retired host keeps the default URI; this one gets its own.
      const uriTaken = (idsByIdentityKey.get(identity.key) ?? []).some(
        (otherId) =>
          otherId !== recordId &&
          viewsByRecord.has(otherId) &&
          keyByRecordId[otherId]?.modelOwnerKey === identity.modelOwnerKey
      )
      indexIdentity(recordId, identity.key)
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
    drafts: draftsChanged ? drafts : input.drafts,
    recovered
  }
}

function findSharedRecord(
  candidates: readonly (readonly [string, EditorBufferKey])[],
  viewsByRecord: ReadonlyMap<string, string[]>,
  identity: EditorBufferIdentity
): { id: string; views: string[] } | undefined {
  let found: { id: string; views: string[] } | undefined
  for (const [id, key] of candidates) {
    const views = viewsByRecord.get(id)
    if (views === undefined || !isSameEditorBuffer(key.identity, identity)) {
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
