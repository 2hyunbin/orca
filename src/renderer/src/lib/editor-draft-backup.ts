import { canBackUpEditorBuffer } from '@/components/editor/editor-buffer-owners'
import { canBackUpNotebookDraft } from '@/components/editor/ipynb-draft-backup'
import type { OpenFile } from '../store/slices/editor'
import { detectLanguage } from './language-detect'

/** The unsaved draft a restart checkpoint carries for this file, or undefined when it can't carry one.
 *  The restart owner and the session builder both decide with this, so they can't disagree. */
export function getBackedUpEditorDraft(
  file: OpenFile,
  editorDrafts: Record<string, string>
): string | undefined {
  // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
  const draft = editorDrafts[file.id]
  if (file.mode !== 'edit' || file.readOnly === true || draft === undefined) {
    return undefined
  }
  const ownerVerdict = canBackUpEditorBuffer(file.id, draft)
  return (ownerVerdict ??
    (detectLanguage(file.filePath) === 'notebook' ? canBackUpNotebookDraft(file, draft) : true))
    ? draft
    : undefined
}
