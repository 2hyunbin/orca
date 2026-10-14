import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { useState, useMemo, useEffect, useCallback } from 'react'
import type { JiraIssue, JiraProjectStatusOrder, JiraPriority } from '../../../shared/jira-types'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import type { TaskPageJiraJqlRejection } from '@/components/task-page-jira-search'
import type { JiraPresetId } from '@/components/task-page-localized-options'
import type {
  JiraIssueSortColumn,
  JiraIssueSortDirection,
  JiraPrioritiesBySite
} from './jira-issue-sorter'
import { jiraListPrioritiesForTarget } from '@/runtime/runtime-jira-client'
import { loadJiraLinkedView, saveJiraLinkedView } from './jira-linked-view-storage'
import {
  fallbackJiraSortColumn,
  loadJiraListColumnIds,
  saveJiraListColumnIds,
  visibleJiraListColumns,
  type JiraListColumnId
} from './jira-list-columns'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
export function useTaskPageJiraListState(model: TaskPageLinearViewStateModel) {
  const {
    jiraConnected,
    selectedJiraSiteId,
    taskSource,
    jiraTaskSourceContext,
    accountBackedTaskSourceHostId
  } = model
  const owner = useMemo(
    () =>
      ipcOrRuntimeTargetForHostId(jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId),
    [accountBackedTaskSourceHostId, jiraTaskSourceContext]
  )
  // Jira tab state
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraError, setJiraError] = useState<TaskPageJiraLoadError | null>(null)
  const [jiraErrorDetailsOpen, setJiraErrorDetailsOpen] = useState(false)
  const [jiraJqlRejection, setJiraJqlRejection] = useState<TaskPageJiraJqlRejection | null>(null)
  const [jiraSearchInput, setJiraSearchInput] = useState('')
  const [appliedJiraSearch, setAppliedJiraSearch] = useState('')
  const [jiraHasWorkspace, setJiraLinkedView] = useState(loadJiraLinkedView)
  const setJiraHasWorkspace = useCallback((enabled: boolean) => {
    setJiraLinkedView(enabled)
    saveJiraLinkedView(enabled)
  }, [])
  const [activeJiraPreset, setActiveJiraPreset] = useState<JiraPresetId>('assigned')
  const [jiraRefreshNonce, setJiraRefreshNonce] = useState(0)
  const [jiraProjectStatusOrder, setJiraProjectStatusOrder] = useState<{
    order: JiraProjectStatusOrder
    scopeKey: string
  } | null>(null)
  const [jiraColumnIds, setJiraColumnIds] =
    useState<ReadonlySet<JiraListColumnId>>(loadJiraListColumnIds)
  const jiraColumns = useMemo(() => visibleJiraListColumns(jiraColumnIds), [jiraColumnIds])
  const [jiraOrderBy, setJiraOrderBy] = useState<JiraIssueSortColumn>(() =>
    fallbackJiraSortColumn(jiraColumnIds)
  )
  const [jiraOrderDirection, setJiraOrderDirection] = useState<JiraIssueSortDirection>('desc')
  const [jiraPrioritiesBySite, setJiraPrioritiesBySite] = useState<JiraPrioritiesBySite>(
    () => new Map()
  )
  const toggleJiraColumn = useCallback(
    (column: JiraListColumnId) => {
      if (column === 'key' || column === 'title') {
        return
      }
      const next = new Set(jiraColumnIds)
      if (next.has(column)) {
        next.delete(column)
      } else {
        next.add(column)
      }
      if (!next.has(jiraOrderBy)) {
        const fallback = fallbackJiraSortColumn(next)
        setJiraOrderBy(fallback)
        setJiraOrderDirection(fallback === 'updated' ? 'desc' : 'asc')
      }
      saveJiraListColumnIds(next)
      setJiraColumnIds(next)
    },
    [jiraColumnIds, jiraOrderBy]
  )
  const jiraPrioritySiteIdsKey = useMemo(() => {
    const siteIds =
      selectedJiraSiteId && selectedJiraSiteId !== 'all'
        ? [selectedJiraSiteId]
        : jiraIssues.flatMap((issue) => (issue.siteId ? [issue.siteId] : []))
    // Why: result refreshes replace the issue array; depend on the represented sites, not identity.
    return JSON.stringify([...new Set(siteIds)].sort())
  }, [jiraIssues, selectedJiraSiteId])
  useEffect(() => {
    if (taskSource !== 'jira' || !jiraConnected || jiraOrderBy !== 'priority' || !owner) {
      setJiraPrioritiesBySite((current) => (current.size === 0 ? current : new Map()))
      return
    }
    let cancelled = false
    const jiraPrioritySiteIds = JSON.parse(jiraPrioritySiteIdsKey) as string[]
    void Promise.all(
      jiraPrioritySiteIds.map(async (siteId) => {
        try {
          return [siteId, await jiraListPrioritiesForTarget(owner, siteId)] as const
        } catch {
          return [siteId, [] as JiraPriority[]] as const
        }
      })
    ).then((prioritiesBySite) => {
      if (!cancelled) {
        setJiraPrioritiesBySite(new Map(prioritiesBySite))
      }
    })
    return () => {
      cancelled = true
    }
  }, [jiraConnected, jiraOrderBy, jiraPrioritySiteIdsKey, owner, taskSource])
  const handleJiraSort = useCallback(
    (column: JiraIssueSortColumn) => {
      if (jiraOrderBy === column) {
        setJiraOrderDirection((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
      } else {
        setJiraOrderBy(column)
        setJiraOrderDirection(column === 'updated' || column === 'status' ? 'desc' : 'asc')
      }
    },
    [jiraOrderBy]
  )
  return Object.assign(model, {
    jiraHasWorkspace,
    setJiraHasWorkspace,
    jiraIssues,
    setJiraIssues,
    jiraLoading,
    setJiraLoading,
    jiraError,
    setJiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraJqlRejection,
    setJiraJqlRejection,
    jiraSearchInput,
    setJiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    activeJiraPreset,
    setActiveJiraPreset,
    jiraRefreshNonce,
    setJiraRefreshNonce,
    jiraProjectStatusOrder,
    setJiraProjectStatusOrder,
    jiraOrderBy,
    setJiraOrderBy,
    jiraOrderDirection,
    setJiraOrderDirection,
    jiraPrioritiesBySite,
    setJiraPrioritiesBySite,
    jiraPrioritySiteIdsKey,
    handleJiraSort,
    jiraColumnIds,
    jiraColumns,
    toggleJiraColumn
  })
}
export type TaskPageJiraListStateModel = ReturnType<typeof useTaskPageJiraListState>
