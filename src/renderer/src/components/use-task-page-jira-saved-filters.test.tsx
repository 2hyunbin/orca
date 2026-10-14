// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import {
  LOCAL_EXECUTION_HOST_ID,
  UNRESOLVED_OWNER_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
const { read, mutate } = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }))
vi.mock('@/runtime/runtime-jira-saved-filter-state', () => ({
  readJiraSavedFilterState: read,
  mutateJiraSavedFilters: mutate
}))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
})
const filter = { id: 'mine', name: 'My work', jql: 'project = APP' }
const initial = { filters: [filter], activeFilterId: filter.id }
function model(
  host: string | null,
  accountHost = 'account-owner'
): Parameters<typeof useTaskPageJiraSavedFilters>[0] {
  return {
    taskSource: 'jira',
    taskResumeApplied: true,
    accountBackedTaskSourceHostId: toRuntimeExecutionHostId(accountHost),
    jiraTaskSourceContext: host
      ? {
          kind: 'task-source',
          provider: 'jira',
          projectId: 'project',
          hostId: toRuntimeExecutionHostId(host)
        }
      : null
  }
}
it('uses the captured account owner without a source context and keeps source ownership first', async () => {
  read.mockResolvedValue(initial)
  mutate.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ sourceHost }) => useTaskPageJiraSavedFilters(model(sourceHost), setQuery),
    { initialProps: { sourceHost: '' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'account-owner' })
  await act(async () => result.current.applyJiraSavedFilter(filter))
  expect(mutate).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'account-owner' },
    { kind: 'select', id: filter.id }
  )
  rerender({ sourceHost: 'source-owner' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'source-owner' })
})
it('does not load or write filters for an unresolved owner', async () => {
  const { result } = renderHook(() =>
    useTaskPageJiraSavedFilters(
      { ...model(null), accountBackedTaskSourceHostId: UNRESOLVED_OWNER_HOST_ID },
      vi.fn()
    )
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  await act(async () => result.current.applyJiraSavedFilter(filter))
  expect(result.current.jiraSavedFiltersReady).toBe(false)
  expect(read).not.toHaveBeenCalled()
  expect(mutate).not.toHaveBeenCalled()
})
it('separates local ownership from a runtime environment named local', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ remote }) =>
      useTaskPageJiraSavedFilters(
        {
          ...model(null),
          accountBackedTaskSourceHostId: remote ? 'runtime:local' : LOCAL_EXECUTION_HOST_ID
        },
        setQuery
      ),
    { initialProps: { remote: false } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  expect(read).toHaveBeenLastCalledWith({ kind: 'local' })
  rerender({ remote: true })
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'local' })
  )
})
it('restores the host selection and reruns its exact JQL after remount', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const first = renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(first.result.current.jiraSavedFiltersReady).toBe(true))
  expect(setQuery).toHaveBeenCalledWith(filter.jql)
  first.unmount()
  setQuery.mockClear()
  renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(setQuery).toHaveBeenCalledWith(filter.jql))
})
it('ignores an old host read that completes after switching execution hosts', async () => {
  let resolveOld: (value: typeof initial) => void = () => {}
  read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce({ filters: [], activeFilterId: null })
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
    { initialProps: { host: 'host-a' } }
  )
  rerender({ host: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => {
    resolveOld(initial)
  })
  expect(result.current.jiraSavedFilters).toEqual([])
  expect(setQuery).not.toHaveBeenCalledWith(filter.jql)
})
it('ignores a late write response from an owner that was left', async () => {
  read.mockResolvedValueOnce(initial).mockResolvedValueOnce({ filters: [], activeFilterId: null })
  let resolveWrite: (value: typeof initial) => void = () => {}
  mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveWrite = resolve
      })
  )
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ host }) => useTaskPageJiraSavedFilters(model(host), setQuery),
    { initialProps: { host: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.applyJiraSavedFilter(filter)
  })
  rerender({ host: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersPending).toBe(false))
  setQuery.mockClear()
  await act(async () => {
    resolveWrite(initial)
    await pending
  })
  expect(result.current.jiraSavedFilters).toEqual([])
  expect(setQuery).not.toHaveBeenCalled()
})
it('does not send a saved filter action retained from a previous account owner', async () => {
  read.mockResolvedValue(initial)
  const setQuery = vi.fn()
  const { result, rerender } = renderHook(
    ({ accountHost }) => useTaskPageJiraSavedFilters(model(null, accountHost), setQuery),
    { initialProps: { accountHost: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  const oldAction = result.current.applyJiraSavedFilter
  rerender({ accountHost: 'host-b' })
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => oldAction(filter))
  expect(mutate).not.toHaveBeenCalled()
})
it('retains stored JQL after failed writes and clears only selection for manual editing', async () => {
  read.mockResolvedValue(initial)
  mutate.mockRejectedValueOnce(new Error('Host disconnected'))
  const setQuery = vi.fn()
  const { result } = renderHook(() => useTaskPageJiraSavedFilters(model('host-a'), setQuery))
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await act(async () => {
    await expect(
      result.current.updateJiraSavedFilter(filter.id, { name: 'New name', jql: 'invalid' })
    ).rejects.toThrow('Host disconnected')
  })
  expect(result.current.jiraSavedFilters).toEqual([filter])
  mutate.mockResolvedValueOnce({ filters: [filter], activeFilterId: null })
  setQuery.mockClear()
  await act(async () => {
    await result.current.clearJiraSavedFilterSelection()
  })
  expect(mutate).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    { kind: 'select', id: null }
  )
  expect(setQuery).not.toHaveBeenCalled()
})
