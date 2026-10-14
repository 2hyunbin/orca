import { createNonSecureContextUuid } from '../../../shared/non-secure-context-uuid'
import { useEffect, useRef, useState } from 'react'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { getJiraRuntimeTarget } from '@/runtime/runtime-jira-target'
import {
  mutateJiraSavedFilters,
  readJiraSavedFilterState
} from '@/runtime/runtime-jira-saved-filter-state'
import {
  normalizeJiraSavedFilterState,
  type JiraSavedFilterMutation,
  type JiraSavedFilter
} from '../../../shared/jira-saved-filters'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { translate } from '@/i18n/i18n'

export function useTaskPageJiraSavedFilters(
  model: TaskPageLinearViewStateModel,
  setQuery: (jql: string) => void
) {
  const source = model.jiraTaskSourceContext ?? defaultScopeSource(model.settings)
  const target = getJiraRuntimeTarget(source)
  const ownerKey = target.kind === 'environment' ? target.environmentId : 'local'
  const [snapshot, setSnapshot] = useState({
    ownerKey: '',
    state: normalizeJiraSavedFilterState(undefined)
  })
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const loadedOwnerRef = useRef<string | null>(null)
  const ownerRef = useRef(ownerKey)
  const ownerEpochRef = useRef(0)
  if (ownerRef.current !== ownerKey) {
    ownerEpochRef.current += 1
    ownerRef.current = ownerKey
  }
  const sourceRef = useRef(source)
  sourceRef.current = source
  const state =
    snapshot.ownerKey === ownerKey ? snapshot.state : normalizeJiraSavedFilterState(undefined)
  const ready = snapshot.ownerKey === ownerKey
  useEffect(() => {
    if (!model.taskResumeApplied || model.taskSource !== 'jira') {
      return
    }
    let cancelled = false
    if (loadedOwnerRef.current !== null && loadedOwnerRef.current !== ownerKey) {
      setQuery('')
    }
    setLoading(true)
    setPending(false)
    setError(null)
    void readJiraSavedFilterState(sourceRef.current)
      .then((next) => {
        if (cancelled) {
          return
        }
        setSnapshot({ ownerKey, state: next })
        const active = next.filters.find((filter) => filter.id === next.activeFilterId)
        if (active) {
          setQuery(active.jql)
        } else if (loadedOwnerRef.current !== null && loadedOwnerRef.current !== ownerKey) {
          setQuery('')
        }
        loadedOwnerRef.current = ownerKey
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : translate('jira.savedFilters.loadFailed', 'Could not load saved Jira filters.')
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
  }, [ownerKey, model.taskSource, model.taskResumeApplied, refresh, setQuery])

  const mutate = async (mutation: JiraSavedFilterMutation): Promise<void> => {
    if (!ready || pending) {
      return
    }
    const expectedOwner = ownerKey
    const expectedEpoch = ownerEpochRef.current
    setPending(true)
    setError(null)
    try {
      const next = await mutateJiraSavedFilters(sourceRef.current, mutation)
      if (ownerRef.current !== expectedOwner || ownerEpochRef.current !== expectedEpoch) {
        return
      }
      setSnapshot({ ownerKey: expectedOwner, state: next })
      if (mutation.kind === 'select') {
        const active = next.filters.find((filter) => filter.id === next.activeFilterId)
        if (active) {
          setQuery(active.jql)
        }
      } else if (mutation.kind === 'save' && next.activeFilterId === mutation.filter.id) {
        setQuery(mutation.filter.jql)
      } else if (mutation.kind === 'delete' && state.activeFilterId === mutation.id) {
        setQuery('')
      }
    } catch (reason) {
      if (ownerRef.current === expectedOwner && ownerEpochRef.current === expectedEpoch) {
        setError(
          reason instanceof Error
            ? reason.message
            : translate('jira.savedFilters.saveFailed', 'Could not save Jira filters.')
        )
      }
      throw reason
    } finally {
      if (ownerRef.current === expectedOwner && ownerEpochRef.current === expectedEpoch) {
        setPending(false)
      }
    }
  }
  return {
    jiraSavedFilters: state.filters,
    jiraActiveSavedFilterId: state.activeFilterId,
    jiraSavedFiltersReady: ready,
    jiraSavedFiltersLoading: loading,
    jiraSavedFiltersPending: pending,
    jiraSavedFiltersError: error,
    retryJiraSavedFilters: () => setRefresh((value) => value + 1),
    applyJiraSavedFilter: (filter: JiraSavedFilter) => mutate({ kind: 'select', id: filter.id }),
    createJiraSavedFilter: (filter: { name: string; jql: string }) =>
      mutate({ kind: 'save', filter: { ...filter, id: createNonSecureContextUuid() } }),
    updateJiraSavedFilter: (id: string, filter: { name: string; jql: string }) =>
      mutate({ kind: 'save', filter: { ...filter, id } }),
    deleteJiraSavedFilter: (id: string) => mutate({ kind: 'delete', id }),
    clearJiraSavedFilterSelection: () =>
      state.activeFilterId ? mutate({ kind: 'select', id: null }) : Promise.resolve()
  }
}
