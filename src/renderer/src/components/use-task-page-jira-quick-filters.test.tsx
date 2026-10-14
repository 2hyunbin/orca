// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskPageJiraQuickFilters } from './use-task-page-jira-quick-filters'
import type { JiraQuickFilterState } from '../../../shared/jira-quick-filters'
import { UNRESOLVED_OWNER_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: read,
  writeJiraQuickFilterState: write
}))
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(cleanup)
function model(
  host: string | null,
  accountHost = 'account-owner'
): Parameters<typeof useTaskPageJiraQuickFilters>[0] {
  return {
    accountBackedTaskSourceHostId: toRuntimeExecutionHostId(accountHost),
    taskSource: 'jira',
    taskResumeApplied: true,
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
  read.mockResolvedValue({ statuses: ['Blocked'] })
  write.mockResolvedValue({ statuses: ['Open'] })
  const { result, rerender } = renderHook(
    ({ sourceHost }) => useTaskPageJiraQuickFilters(model(sourceHost)),
    { initialProps: { sourceHost: '' } }
  )
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'account-owner' })
  await act(async () => result.current.selectJiraStatuses(['Open']))
  expect(write).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'account-owner' },
    { statuses: ['Open'] }
  )
  rerender({ sourceHost: 'source-owner' })
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  expect(read).toHaveBeenLastCalledWith({ kind: 'environment', environmentId: 'source-owner' })
})
it('does not load or write status filters for an unresolved owner', async () => {
  const { result } = renderHook(() =>
    useTaskPageJiraQuickFilters({
      ...model(null),
      accountBackedTaskSourceHostId: UNRESOLVED_OWNER_HOST_ID
    })
  )
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  await act(async () => result.current.selectJiraStatuses(['Open']))
  expect(result.current.jiraQuickFiltersReady).toBe(false)
  expect(read).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
it('restores selection after remount and waits for writes to reach the host', async () => {
  read
    .mockResolvedValueOnce({ statuses: ['Blocked'] })
    .mockResolvedValueOnce({ statuses: ['In Progress'] })
  let finish: (value: JiraQuickFilterState) => void = () => {}
  write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const first = renderHook(() => useTaskPageJiraQuickFilters(model('a')))
  await waitFor(() => expect(first.result.current.jiraQuickFiltersLoading).toBe(false))
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = first.result.current.selectJiraStatuses(['In Progress'])
  })
  expect(first.result.current.selectedJiraStatuses).toEqual(['Blocked'])
  expect(first.result.current.jiraQuickFiltersPending).toBe(true)
  await act(async () => {
    finish({ statuses: ['In Progress'] })
    await pending
  })
  expect(first.result.current.selectedJiraStatuses).toEqual(['In Progress'])
  first.unmount()
  const restored = renderHook(() => useTaskPageJiraQuickFilters(model('a')))
  await waitFor(() => expect(restored.result.current.selectedJiraStatuses).toEqual(['In Progress']))
})
it('retains selection after a failed write', async () => {
  read.mockResolvedValue({ statuses: ['Blocked'] })
  write.mockRejectedValue(new Error('Host unreachable'))
  const { result } = renderHook(() => useTaskPageJiraQuickFilters(model('a')))
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  await act(async () => {
    await expect(result.current.selectJiraStatuses([])).rejects.toThrow('Host unreachable')
  })
  expect(result.current.selectedJiraStatuses).toEqual(['Blocked'])
  expect(result.current.jiraQuickFiltersError).toBe('Host unreachable')
})
it('ignores a late mutation reply after changing Jira execution hosts', async () => {
  read
    .mockResolvedValueOnce({ statuses: ['Blocked'] })
    .mockResolvedValueOnce({ statuses: ['Open'] })
  let finish: (value: JiraQuickFilterState) => void = () => {}
  write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result, rerender } = renderHook(({ host }) => useTaskPageJiraQuickFilters(model(host)), {
    initialProps: { host: 'a' }
  })
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = result.current.selectJiraStatuses(['In Progress'])
  })
  rerender({ host: 'b' })
  await waitFor(() => expect(result.current.selectedJiraStatuses).toEqual(['Open']))
  await act(async () => {
    finish({ statuses: ['In Progress'] })
    await pending
  })
  expect(result.current.selectedJiraStatuses).toEqual(['Open'])
})
it('keeps unsupported-host empty selection stable across renders', async () => {
  read.mockRejectedValue(new Error('Update host'))
  const { result, rerender } = renderHook(() => useTaskPageJiraQuickFilters(model('a')))
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  const first = result.current.selectedJiraStatuses
  rerender()
  expect(result.current.selectedJiraStatuses).toBe(first)
  expect(result.current.jiraQuickFiltersReady).toBe(false)
})
it('does not send a status filter action retained from a previous account owner', async () => {
  read.mockResolvedValue({ statuses: ['Blocked'] })
  const { result, rerender } = renderHook(
    ({ accountHost }) => useTaskPageJiraQuickFilters(model(null, accountHost)),
    { initialProps: { accountHost: 'host-a' } }
  )
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  const oldAction = result.current.selectJiraStatuses
  rerender({ accountHost: 'host-b' })
  await waitFor(() => expect(result.current.jiraQuickFiltersLoading).toBe(false))
  await act(async () => oldAction(['Open']))
  expect(write).not.toHaveBeenCalled()
})
