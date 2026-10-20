import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import {
  beginEditorBufferRead,
  editorBufferFreshnessKeyOf,
  isEditorBufferReadCurrent
} from '@/store/slices/editor/buffers/editor-buffer-read-freshness'

export type EditorTabDiskRead = {
  content: Promise<{ content: string; isBinary: boolean }>
  /** False once a newer read, write, reload or Keep of the same file started. */
  isCurrent: () => boolean
}

/** Reads a tab's file from its owning host as one read of the file's freshness counter; null when the owner is unknown. */
export function readEditorTabDisk(file: OpenFile): EditorTabDiskRead | null {
  const state = useAppStore.getState()
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (!target) {
    return null
  }
  const fileKey = editorBufferFreshnessKeyOf(state, file.id)
  const token = beginEditorBufferRead(fileKey)
  return {
    content: readRuntimeFileContent({
      target,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
      expectedExternalSshTargetId: file.externalSshTargetId,
      access: editorTabFileAccess(state, file)
    }),
    isCurrent: () => isEditorBufferReadCurrent(fileKey, token)
  }
}
