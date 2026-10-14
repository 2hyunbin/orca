// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'
import { createCmdJTaskSearchRequests } from './cmd-j/task-search-requests'
import { jiraTaskResult } from './cmd-j/task-search.test-fixture'
import { EMPTY_PALETTE_FILTER } from './cmd-j/palette-filter'
import { buildPaletteFilterModel } from './cmd-j/palette-filter-options'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'

vi.mock('./cmd-j/task-search-requests', () => ({ createCmdJTaskSearchRequests: vi.fn() }))
const input = {
  visible: true,
  query: 'login redirect',
  settings: createGlobalSettingsFixture({ visibleTaskProviders: ['jira'] }),
  repos: [],
  hostOptions: [],
  filter: EMPTY_PALETTE_FILTER,
  filterModel: buildPaletteFilterModel({
    repos: [],
    worktrees: [],
    hostOptions: [],
    projects: [],
    projectHostSetups: [],
    defaultHostId: 'local'
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(createCmdJTaskSearchRequests).mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('debounces queries without starting the old request and delays loading feedback', async () => {
  const run = vi.fn(() => new Promise<(typeof jiraTaskResult)[]>(() => {}))
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'jira', provider: 'jira', hostLabel: 'Local', run }
  ])
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(200))
  rerender({ ...input, query: 'new query' })
  await act(async () => vi.advanceTimersByTimeAsync(299))
  expect(run).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(run).toHaveBeenCalledTimes(1)
  expect(result.current.taskSearchLoading).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  expect(result.current.taskSearchLoading).toBe(true)
})

it('publishes a fast source while a second is pending, then discards both after close', async () => {
  let complete: (results: (typeof jiraTaskResult)[]) => void = () => {}
  const slow = new Promise<(typeof jiraTaskResult)[]>((resolve) => {
    complete = resolve
  })
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'fast', provider: 'jira', hostLabel: 'Local', run: async () => [jiraTaskResult] },
    { id: 'slow', provider: 'jira', hostLabel: 'Remote', run: () => slow }
  ])
  const { result, rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(result.current.taskItems.map((item) => item.id)).toEqual([jiraTaskResult.id])
  rerender({ ...input, visible: false })
  await act(async () => complete([{ ...jiraTaskResult, id: 'late' }]))
  expect(result.current.taskItems).toEqual([])
  rerender(input)
  expect(result.current.taskItems).toEqual([])
})

it('ignores unrelated settings and repo object identity changes', async () => {
  const run = vi.fn(async () => [jiraTaskResult])
  vi.mocked(createCmdJTaskSearchRequests).mockReturnValue([
    { id: 'jira', provider: 'jira', hostLabel: 'Local', run }
  ])
  const { rerender } = renderHook(useWorktreeJumpPaletteTaskSearch, { initialProps: input })
  await act(async () => vi.advanceTimersByTimeAsync(300))
  rerender({ ...input, settings: { ...input.settings }, repos: [] })
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(run).toHaveBeenCalledTimes(1)
})
