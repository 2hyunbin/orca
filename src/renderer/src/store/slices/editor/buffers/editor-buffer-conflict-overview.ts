import type { OpenFile } from '../types/open-file'
import type { EditorBufferViewIndex } from './editor-buffer-views'
import {
  editorBufferIdentityKeyOf,
  type EditorBufferRouteState
} from './editor-buffer-identity-cache'

export type ConflictOverviewState = EditorBufferRouteState &
  Partial<Pick<EditorBufferViewIndex, 'editorBufferViews'>> & { openFiles: readonly OpenFile[] }

const MAX_LOOKUP_FILES = 256
const lookupFiles = new Map<string, OpenFile>()

/** One stand-in edit tab per path, so the per-tab identity cache answers repeat lookups. */
function lookupFileOf(worktreeId: string, filePath: string): OpenFile {
  const key = JSON.stringify([worktreeId, filePath])
  let file = lookupFiles.get(key)
  if (!file) {
    if (lookupFiles.size >= MAX_LOOKUP_FILES) {
      lookupFiles.clear()
    }
    file = {
      id: filePath,
      filePath,
      relativePath: filePath,
      worktreeId,
      language: 'plaintext',
      isDirty: false,
      mode: 'edit'
    }
    lookupFiles.set(key, file)
  }
  return file
}

/**
 * The open view a conflict-review overview reads a file through, so it shows that record's current
 * text and model (read-only; the overview is never a view itself). Any workspace's view of the
 * file's record, this workspace's first; else this workspace's edit tab; null shows disk text.
 */
export function conflictOverviewView(
  state: ConflictOverviewState,
  worktreeId: string,
  filePath: string
): OpenFile | null {
  const key = editorBufferIdentityKeyOf(lookupFileOf(worktreeId, filePath), state)
  const viewIds = key === null ? undefined : state.editorBufferViews?.[key]
  const recordViews = viewIds ? state.openFiles.filter((file) => viewIds.includes(file.id)) : []
  return (
    recordViews.find((file) => file.worktreeId === worktreeId) ??
    recordViews[0] ??
    state.openFiles.find(
      (file) => file.filePath === filePath && file.worktreeId === worktreeId && file.mode === 'edit'
    ) ??
    null
  )
}
