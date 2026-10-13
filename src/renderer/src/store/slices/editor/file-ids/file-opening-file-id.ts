import { buildOwnedEditorFileId } from './editor-file-ids'

export function fileOpeningFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId?: string | null
): string {
  return `file-opening:${buildOwnedEditorFileId(filePath, worktreeId, runtimeEnvironmentId)}`
}
