// Editor tabs whose file record the window dropped, in a layout-owner build: main closes them.
// A single tab's close goes through `closeContentTabThroughLayoutOwner`.

import { sendLayoutApply } from '@/runtime/layout-apply-send'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'

/** Editor tabs of a workspace whose file record the window just dropped: main closes them. */
export function closeDroppedEditorFileTabsThroughLayoutOwner(
  state: AppState,
  filesBefore: readonly Pick<OpenFile, 'id' | 'worktreeId'>[],
  worktreeId: string
): void {
  const kept = new Set(state.openFiles.map((file) => file.id))
  const dropped = new Set(
    filesBefore.flatMap((file) =>
      file.worktreeId === worktreeId && !kept.has(file.id) ? [file.id] : []
    )
  )
  const keep = (): void => {}
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (dropped.has(tab.entityId) && isEditorTabContentType(tab.contentType)) {
      sendLayoutApply(
        state,
        worktreeId,
        { type: 'closeTabs', tabIds: [tab.id] },
        { apply: keep, asToday: keep }
      )
    }
  }
}
