import type { EditorBufferRecord } from './editor-buffer-record'

/** One side of a join: a record and the draft its views hold. */
export type EditorBufferJoinSide = { record: EditorBufferRecord; draft: string | undefined }

/**
 * How a view joins the record that already holds its file identity.
 * - `rekey`: no record holds it yet, so the view's record takes the key.
 * - `attach`: the target stands (both clean, or only the target dirty).
 * - `adopt`: only the joining side is dirty, so its draft, baseline and conflict state win.
 * - `merge`: both dirty with the same draft and baseline.
 * - `detach`: divergent dirty drafts; the joining view keeps its own record and model.
 */
export type EditorBufferJoin = 'rekey' | 'attach' | 'adopt' | 'merge' | 'detach'

function isDirtySide(side: EditorBufferJoinSide): boolean {
  return side.record.isDirty
}

export function decideEditorBufferJoin(
  target: EditorBufferJoinSide | null,
  joining: EditorBufferJoinSide
): EditorBufferJoin {
  if (!target) {
    return 'rekey'
  }
  if (!isDirtySide(joining)) {
    return 'attach'
  }
  if (!isDirtySide(target)) {
    return 'adopt'
  }
  const identical =
    target.draft === joining.draft &&
    target.record.lastKnownDiskSignature === joining.record.lastKnownDiskSignature
  return identical ? 'merge' : 'detach'
}

/**
 * Whether a detached record and its partner join again: only once one side is clean, which then
 * joins as a clean view. Two dirty sides never merge, even with identical text.
 */
export function decideEditorBufferRejoin(
  detached: EditorBufferJoinSide,
  partner: EditorBufferJoinSide
): Exclude<EditorBufferJoin, 'rekey' | 'merge' | 'detach'> | null {
  if (isDirtySide(detached) && isDirtySide(partner)) {
    return null
  }
  return isDirtySide(detached) ? 'adopt' : 'attach'
}

/** The record and draft the joined record holds; null when the sides stay apart. */
export function joinedEditorBuffer(
  target: EditorBufferJoinSide | null,
  joining: EditorBufferJoinSide,
  join: EditorBufferJoin
): EditorBufferJoinSide | null {
  switch (join) {
    case 'rekey':
    case 'adopt':
      return joining
    case 'attach':
    case 'merge':
      return target ?? joining
    case 'detach':
      return null
  }
}
