import { buildOwnedEditorFileId } from './editor-file-ids'

export function pluginViewerFileId(
  filePath: string,
  workspaceId: string,
  runtimeEnvironmentId: string | null | undefined,
  viewerKey: string
): string {
  return `viewer:${encodeURIComponent(viewerKey)}:${buildOwnedEditorFileId(filePath, workspaceId, runtimeEnvironmentId)}`
}
