import { useEffect, useMemo, useRef, useState } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  readJiraQuickFilterState,
  writeJiraQuickFilterState
} from '@/runtime/runtime-jira-quick-filter-state'
import {
  normalizeJiraQuickFilterState,
  type JiraQuickFilterState
} from '../../../shared/jira-quick-filters'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { translate } from '@/i18n/i18n'

const EMPTY_QUICK_FILTER_STATE: JiraQuickFilterState = { statuses: [] }
type JiraQuickFilterModel = Pick<
  TaskPageLinearViewStateModel,
  'jiraTaskSourceContext' | 'accountBackedTaskSourceHostId' | 'taskResumeApplied' | 'taskSource'
>

export function useTaskPageJiraQuickFilters(model: JiraQuickFilterModel) {
  const ownerKey = model.jiraTaskSourceContext?.hostId ?? model.accountBackedTaskSourceHostId
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(ownerKey), [ownerKey])
  const [snapshot, setSnapshot] = useState({
    ownerKey: '',
    state: normalizeJiraQuickFilterState(undefined)
  })
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const ownerRef = useRef(ownerKey)
  const epochRef = useRef(0)
  const writePendingRef = useRef(false)
  if (ownerRef.current !== ownerKey) {
    epochRef.current += 1
    ownerRef.current = ownerKey
    writePendingRef.current = false
  }
  const ready = target !== null && snapshot.ownerKey === ownerKey
  const state = ready ? snapshot.state : EMPTY_QUICK_FILTER_STATE
  useEffect(() => {
    if (!model.taskResumeApplied || model.taskSource !== 'jira') {
      return
    }
    let cancelled = false
    setLoading(true)
    setPending(false)
    setError(null)
    if (!target) {
      setLoading(false)
      return
    }
    void readJiraQuickFilterState(target)
      .then((next) => {
        if (!cancelled) {
          setSnapshot({ ownerKey, state: next })
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : translate('jira.statusFilters.loadFailed', 'Could not load Jira status filters.')
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [ownerKey, target, model.taskResumeApplied, model.taskSource, refresh])

  const select = async (statuses: string[]): Promise<void> => {
    if (!ready || loading || writePendingRef.current || !target || ownerRef.current !== ownerKey) {
      return
    }
    const expectedOwner = ownerKey
    const expectedEpoch = epochRef.current
    const stillCurrent = () =>
      ownerRef.current === expectedOwner && epochRef.current === expectedEpoch
    writePendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const next = await writeJiraQuickFilterState(target, { statuses })
      if (stillCurrent()) {
        setSnapshot({ ownerKey: expectedOwner, state: next })
      }
    } catch (reason) {
      if (stillCurrent()) {
        setError(
          reason instanceof Error
            ? reason.message
            : translate('jira.statusFilters.saveFailed', 'Could not save Jira status filters.')
        )
      }
      throw reason
    } finally {
      if (stillCurrent()) {
        writePendingRef.current = false
        setPending(false)
      }
    }
  }
  return {
    selectedJiraStatuses: state.statuses,
    jiraQuickFiltersReady: ready,
    jiraQuickFiltersLoading: loading,
    jiraQuickFiltersPending: pending,
    jiraQuickFiltersError: error,
    retryJiraQuickFilters: () => setRefresh((value) => value + 1),
    selectJiraStatuses: select
  }
}
