import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubTaskKind } from '../../../../../shared/task-github-search'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'
import type { TaskPageRepoSourceState } from '../task-page-cache-selectors'

export function getTaskPresetViewerLogin(
  kind: GitHubTaskKind,
  sources: readonly TaskPageRepoSourceState[],
  viewerLogin: string | null
): string | null {
  // The existing viewer lookup identifies only this runtime's default GitHub account.
  return sources.some((state) => {
    const source = kind === 'prs' ? state.sources?.prs : state.sources?.issues
    return state.hostId !== 'local' || (source?.host && source.host !== 'github.com')
  })
    ? null
    : viewerLogin
}

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
