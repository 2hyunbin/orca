import { decideEditorBufferRejoin, type EditorBufferJoinSide } from './editor-buffer-join'
import type { EditorBufferReconcileState } from './editor-buffer-reconcile-write'
import type { EditorBufferDetachments } from './editor-buffer-views'

/** `recordId`'s side as of the previous write, through its first view `isShown` accepts. */
function sideOf(
  state: EditorBufferReconcileState,
  recordId: string,
  isShown: (viewId: string) => boolean = () => true
): EditorBufferJoinSide | null {
  const record = state.editorBuffers[recordId]
  const firstView = state.editorBufferViews[recordId]?.find(isShown)
  return record && firstView !== undefined ? { record, draft: state.editorDrafts[firstView] } : null
}

/** A detached record stays apart only while both it and its still-open partner hold edits. */
export function staysDetached(
  state: EditorBufferReconcileState,
  entry: EditorBufferDetachments[string],
  open: ReadonlySet<string>
): boolean {
  const own = sideOf(state, entry.recordId)
  const partner = sideOf(state, entry.key, (viewId) => open.has(viewId))
  return own !== null && partner !== null && decideEditorBufferRejoin(own, partner) === null
}

/** Whether a detached view could rejoin its partner now (one side clean, or the partner closed). */
export function isEditorBufferRejoinDue(state: EditorBufferReconcileState): boolean {
  const open = new Set(state.openFiles.map((file) => file.id))
  return Object.entries(state.editorBufferDetached).some(
    ([viewId, entry]) => open.has(viewId) && !entry.retired && !staysDetached(state, entry, open)
  )
}
