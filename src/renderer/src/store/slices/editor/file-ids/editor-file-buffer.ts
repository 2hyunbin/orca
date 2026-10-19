import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { getEditorModelOwnerKey } from '@/components/editor/editor-model-owner'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'

/**
 * One editor buffer per physical file (host + path): every edit tab showing it, in any workspace,
 * shares its Monaco model, so it must also share the draft, dirty flag and disk state. The model
 * URI is that identity, so the two can never disagree.
 */
export function getEditorBufferKey(file: OpenFile, state: AppState): string {
  return file.mode === 'edit'
    ? toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state))
    : `tab:${file.id}`
}

function sharesBuffers(file: OpenFile): boolean {
  return file.mode === 'edit' && file.readOnly !== true && file.csvPreviewOnly !== true
}

// Cheap superset of "same path" (case and separators folded); the buffer key decides.
function loosePathKey(filePath: string): string {
  return filePath.replaceAll('\\', '/').toLowerCase()
}

/** Every open tab sharing `fileId`'s buffer, `fileId` first. */
export function getSameBufferFileIds(state: AppState, fileId: string): string[] {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file || !sharesBuffers(file)) {
    return [fileId]
  }
  const path = loosePathKey(file.filePath)
  // Runs per keystroke: resolve owners only for the rare tab with a matching path.
  const candidates = state.openFiles.filter(
    (candidate) =>
      candidate.id !== fileId &&
      sharesBuffers(candidate) &&
      loosePathKey(candidate.filePath) === path
  )
  if (candidates.length === 0) {
    return [fileId]
  }
  const key = getEditorBufferKey(file, state)
  return [
    fileId,
    ...candidates
      .filter((candidate) => getEditorBufferKey(candidate, state) === key)
      .map((candidate) => candidate.id)
  ]
}

/** Every open tab sharing `fileId`'s buffer, `fileId` first. */
export function getSameBufferFiles(state: AppState, fileId: string): OpenFile[] {
  return getSameBufferFileIds(state, fileId).flatMap(
    (id) => state.openFiles.find((file) => file.id === id) ?? []
  )
}

/** Closing a tab only prompts to save when no other tab still shows its buffer. */
export function needsSavePromptOnClose(state: AppState, fileId: string): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  return file?.isDirty === true && getSameBufferFileIds(state, fileId).length === 1
}

/** A new tab joins an already-open buffer: adopt its unsaved draft and disk state. */
export function adoptOpenEditorBuffer(state: AppState, fileId: string): Partial<AppState> | null {
  const [, peerId] = getSameBufferFileIds(state, fileId)
  const peer = peerId ? state.openFiles.find((file) => file.id === peerId) : undefined
  if (!peer) {
    return null
  }
  const draft = state.editorDrafts[peer.id]
  return {
    openFiles: state.openFiles.map((file) =>
      file.id === fileId
        ? {
            ...file,
            isDirty: peer.isDirty,
            lastKnownDiskSignature: peer.lastKnownDiskSignature,
            externalMutation: peer.externalMutation,
            pendingDiskBaselineVerification: peer.pendingDiskBaselineVerification,
            pendingLiveDiskVerification: peer.pendingLiveDiskVerification,
            pendingOwnerMigration: file.pendingOwnerMigration || peer.pendingOwnerMigration
          }
        : file
    ),
    ...(draft === undefined ? {} : { editorDrafts: { ...state.editorDrafts, [fileId]: draft } })
  }
}
