import { editorTabFileAccess } from '@/lib/local-file-access'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import type { LocalFileAccess } from '../../../../shared/local-file-access'

export function pluginViewerSelectedFileAccess(
  state: Pick<AppState, 'settings'>,
  file: OpenFile
): Extract<LocalFileAccess, { kind: 'user-file' }> | undefined {
  if (
    file.mode === 'plugin-viewer' &&
    file.readOnly === true &&
    file.pluginViewerUserSelectedFile === true &&
    file.relativePath === file.filePath &&
    file.operationProvenance?.generation.route.executionHostId !== undefined &&
    file.operationProvenance.generation.route.executionHostId !== 'local'
  ) {
    // Only desktop main can turn this gesture into host-issued file authority.
    return { kind: 'user-file' }
  }
  const access = editorTabFileAccess(state, file)
  return access?.kind === 'user-file' ? access : undefined
}
