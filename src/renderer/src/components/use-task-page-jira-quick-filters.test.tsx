// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskPageJiraQuickFilters } from './use-task-page-jira-quick-filters'
import type { JiraQuickFilterState } from '../../../shared/jira-quick-filters'
const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('@/runtime/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: read,
  writeJiraQuickFilterState: write
}))
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(cleanup)
function model(host: string): Parameters<typeof useTaskPageJiraQuickFilters>[0] {
  return {
    settings: null,
    taskSource: 'jira',
    taskResumeApplied: true,
    jiraTaskSourceContext: {
      kind: 'task-source',
      provider: 'jira',
      projectId: 'project',
      hostId: `runtime:${host}`
    }
  }
}
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
