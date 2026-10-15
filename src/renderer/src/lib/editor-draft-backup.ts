import type { OpenFile } from '../store/slices/editor'

/** Whether a restart checkpoint carries this file's unsaved draft; the restart owner and the
 *  session builder both decide with this, so they can't disagree about what survives. */
export function isEditorDraftBackedUp(
  file: OpenFile,
  editorDrafts: Record<string, string>
): boolean {
  // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
  return file.mode === 'edit' && file.readOnly !== true && editorDrafts[file.id] !== undefined
}
