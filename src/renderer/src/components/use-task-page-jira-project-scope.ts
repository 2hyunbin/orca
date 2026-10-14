import { useCallback, useState } from 'react'
import type { Repo } from '../../../shared/repo-types'
import type { JiraProjectReference } from '../../../shared/jira-project-reference'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveJiraSourceHostId } from '../../../shared/jira-source-host'

export function useTaskPageJiraProjectScope(
  repos: readonly Repo[],
  selectedRepos: readonly Repo[],
  preselectedRepoId: string | undefined,
  hostId: ExecutionHostId,
  siteId: string | null | undefined
) {
  const repo =
    (preselectedRepoId
      ? repos.find(
          (entry) =>
            entry.id === preselectedRepoId &&
            resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(entry) }) === hostId
        )
      : null) ?? (selectedRepos.length === 1 ? selectedRepos[0] : null)
  const scopeKey = `${hostId}:${repo?.id ?? ''}:${siteId ?? ''}`
  const [override, setOverride] = useState<{
    scopeKey: string
    project: JiraProjectReference | null
  } | null>(null)
  const defaultProject =
    repo && resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(repo) }) === hostId
      ? (repo.defaultJiraProject ?? null)
      : null
  const jiraProjectFilter =
    override?.scopeKey === scopeKey
      ? override.project
      : defaultProject && (!siteId || siteId === 'all' || defaultProject.siteId === siteId)
        ? defaultProject
        : null
  const setJiraProjectFilter = useCallback(
    (project: JiraProjectReference | null) => setOverride({ scopeKey, project }),
    [scopeKey]
  )
  return { jiraProjectFilter, setJiraProjectFilter }
}
