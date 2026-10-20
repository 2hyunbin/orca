import type { RecoveredEditorDraft } from '../../../../../../shared/workspace-session-state-types'

const MAX_RECOVERED_DRAFTS = 20
const MAX_RECOVERED_DRAFT_CHARS = 2 * 1024 * 1024

/** Adds drafts, keeping the newest within the cap; this only migrates older sessions. */
export function appendRecoveredEditorDrafts(
  existing: readonly RecoveredEditorDraft[],
  added: readonly RecoveredEditorDraft[]
): RecoveredEditorDraft[] {
  const all = [...existing, ...added].sort((a, b) => b.recoveredAt - a.recoveredAt)
  const kept: RecoveredEditorDraft[] = []
  let chars = 0
  for (const draft of all) {
    if (
      kept.length >= MAX_RECOVERED_DRAFTS ||
      chars + draft.draft.length > MAX_RECOVERED_DRAFT_CHARS
    ) {
      console.warn('[editor] dropped an older recovered draft over the cap', draft.filePath)
      continue
    }
    kept.push(draft)
    chars += draft.draft.length
  }
  return kept.toReversed()
}

export function isSameRecoveredEditorDraft(
  a: RecoveredEditorDraft,
  b: RecoveredEditorDraft
): boolean {
  return (
    a.filePath === b.filePath && a.worktreeId === b.worktreeId && a.recoveredAt === b.recoveredAt
  )
}

/** Omitted when empty, so sessions without recovered drafts look exactly as before. */
export function recoveredEditorDraftsSessionField(
  drafts: readonly RecoveredEditorDraft[] | undefined
): { recoveredEditorDrafts?: RecoveredEditorDraft[] } {
  return drafts && drafts.length > 0 ? { recoveredEditorDrafts: [...drafts] } : {}
}
