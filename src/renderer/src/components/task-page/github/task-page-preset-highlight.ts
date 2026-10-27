import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubTaskKind } from '../../../../../shared/task-github-search'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'

function matchesViewer(qualifier: string | null, viewerLogin: string | null): boolean {
  if (!qualifier) {
    return false
  }
  const normalized = qualifier.toLowerCase()
  return normalized === '@me' || (!!viewerLogin && normalized === viewerLogin.toLowerCase())
}

export function deriveGitHubTaskPreset(
  kind: GitHubTaskKind,
  query: ParsedTaskQuery,
  viewerLogin: string | null
): TaskViewPresetId | null {
  if (query.state !== null && query.state !== 'open') {
    return null
  }
  if (kind === 'prs') {
    if (matchesViewer(query.author, viewerLogin)) {
      return 'my-prs'
    }
    if (matchesViewer(query.reviewRequested, viewerLogin)) {
      return 'review'
    }
  } else if (matchesViewer(query.assignee, viewerLogin)) {
    return 'my-issues'
  }
  return query.author !== null ||
    query.assignee !== null ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
    ? null
    : kind === 'prs'
      ? 'prs'
      : 'issues'
}
