import type { AppState } from '@/store'
import { editorBufferIdOf } from '@/store/slices/editor/buffers/editor-buffer-record'
import {
  isSameEditorBuffer,
  type EditorBufferIdentity
} from '@/store/slices/editor/buffers/editor-buffer-identity'

type LastWrite = { recordId: string; identity: EditorBufferIdentity; signature: string }

/**
 * The last write per physical file, so records of one file kept apart (different unsaved drafts)
 * never silently replace each other's write: a record whose disk version predates another
 * record's write is marked changed-on-disk instead.
 */
export function createEditorFileWriteLedger(): {
  /** True when another record of the file wrote after `baseline`. */
  isStaleWrite: (
    fileKey: string,
    recordId: string,
    identity: EditorBufferIdentity | undefined,
    baseline: string | undefined
  ) => boolean
  recordWrite: (
    fileKey: string,
    recordId: string,
    identity: EditorBufferIdentity | undefined,
    signature: string
  ) => void
  clear: () => void
} {
  const lastWriteByFile = new Map<string, LastWrite>()
  return {
    isStaleWrite: (fileKey, recordId, identity, baseline) => {
      const last = lastWriteByFile.get(fileKey)
      return (
        identity !== undefined &&
        last !== undefined &&
        last.recordId !== recordId &&
        isSameEditorBuffer(last.identity, identity) &&
        baseline !== last.signature
      )
    },
    recordWrite: (fileKey, recordId, identity, signature) => {
      if (identity) {
        lastWriteByFile.set(fileKey, { recordId, identity, signature })
      }
    },
    clear: () => lastWriteByFile.clear()
  }
}

/** After a write, other dirty records of the same file hold edits against an older disk version. */
export function markOtherEditorRecordsChanged(
  state: AppState,
  recordId: string,
  identity: EditorBufferIdentity | undefined
): void {
  if (identity === undefined) {
    return
  }
  for (const other of state.openFiles) {
    const otherId = editorBufferIdOf(state, other.id)
    const otherIdentity = state.editorBufferIndex?.keyByRecordId[otherId]?.identity
    if (
      otherId !== recordId &&
      other.isDirty &&
      otherIdentity !== undefined &&
      isSameEditorBuffer(otherIdentity, identity)
    ) {
      state.setExternalMutation(other.id, 'changed')
    }
  }
}
