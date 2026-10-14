// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
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
function model(host: string): TaskPageLinearViewStateModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook only reads the four fields supplied by the fixture.
  return {
    taskSource: 'jira',
    taskResumeApplied: true,
    settings: null,
    jiraTaskSourceContext: { kind: 'environment', environmentId: host }
  } as unknown as TaskPageLinearViewStateModel
}
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
