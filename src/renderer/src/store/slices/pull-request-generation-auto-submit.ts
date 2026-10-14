import { prefixJiraReviewTitle } from '../../../../shared/jira-review-title'
import type {
  PullRequestFieldRevisions,
  PullRequestGenerationFields,
  PullRequestGenerationRecord
} from './pull-request-generation'

// Why: an auto-submitted run (Create PR) is sent without the user reviewing it in the form.
export type PullRequestGenerationOptions = { autoSubmit?: boolean }

export function recordPullRequestGenerationEdits(
  record: PullRequestGenerationRecord | null,
  fields: PullRequestGenerationFields,
  revisions: PullRequestFieldRevisions
): PullRequestGenerationRecord | null {
  if (!record || record.status !== 'running' || !record.autoSubmit) {
    return null
  }
  const edited = record.editedFields ?? {
    fields: record.seed,
    revisions: record.seedFieldRevisions
  }
  const next = { fields: { ...edited.fields }, revisions: { ...edited.revisions } }
  let changed = false
  for (const field of ['base', 'title', 'body', 'draft'] as const) {
    if (revisions[field] <= next.revisions[field]) {
      continue
    }
    if (field === 'draft') {
      next.fields.draft = fields.draft
    } else {
      next.fields[field] = fields[field]
    }
    next.revisions[field] = revisions[field]
    changed = true
  }
  return changed ? { ...record, editedFields: next } : null
}

type ResolvableRecord = Pick<
  PullRequestGenerationRecord,
  'autoSubmit' | 'seed' | 'seedFieldRevisions' | 'editedFields'
> &
  Pick<Partial<PullRequestGenerationRecord>, 'context'>

/**
 * Draft is a decision, not prose: the agent may flag unfinished work, but it never reverts a box the
 * user set — a silently unchecked Draft opens a real review ready for everyone, which no edit undoes.
 */
export function resolveGeneratedDraft(
  { seed, seedFieldRevisions }: Omit<ResolvableRecord, 'autoSubmit'>,
  result: PullRequestGenerationFields
): boolean {
  return seed.draft || (seedFieldRevisions.draft === 0 && result.draft)
}

/**
 * What a finished run is allowed to change. Every run honours the Draft choice; only a run sent
 * unreviewed also keeps the user's base, as the prepare-branch route does — a Generate-button base
 * lands in the form, where the user still sees it and can change it before creating.
 */
export function resolveGeneratedFields(
  record: ResolvableRecord,
  result: PullRequestGenerationFields
): PullRequestGenerationFields {
  const draft = resolveGeneratedDraft(record, result)
  const jiraIssueKey = record.context?.jiraIssueKey
  const title =
    jiraIssueKey && record.seedFieldRevisions.title > 0
      ? record.seed.title
      : prefixJiraReviewTitle(result.title, jiraIssueKey)
  const resolved = record.autoSubmit
    ? { ...result, base: record.seed.base, title, draft }
    : { ...result, title, draft }
  const edited = record.editedFields
  if (record.autoSubmit && edited) {
    for (const field of ['base', 'title', 'body', 'draft'] as const) {
      if (edited.revisions[field] <= record.seedFieldRevisions[field]) {
        continue
      }
      if (field === 'draft') {
        resolved.draft = edited.fields.draft
      } else {
        resolved[field] = edited.fields[field]
      }
    }
  }
  return resolved
}
