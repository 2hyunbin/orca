import { beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { JiraIssue, JiraIssueListFilters } from '../../../../shared/jira-types'
import { createJiraSlice } from './jira'
const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListIssues: list,
  jiraSearchIssues: vi.fn()
}))
beforeEach(() => {
  vi.resetAllMocks()
})
function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    title: key,
    url: `https://jira.example/browse/${key}`,
    project: { id: 'project', key: 'APP', name: 'App' },
    issueType: { id: 'bug', name: 'Bug' },
    status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01'
  }
}
it('isolates status results from preset caches and reuses an equivalent selection order', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only settings and Jira slice fields are accessed by these list reads.
  const store = create<AppState>()(
    (...args) => ({ settings: null, ...createJiraSlice(...args) }) as AppState
  )
  list.mockImplementation(
    async (_source, _preset, _limit, _site, filters?: JiraIssueListFilters) => [
      issue(filters?.statuses?.join('-') || 'default')
    ]
  )
  expect(await store.getState().listJiraIssues('all', 50)).toMatchObject([{ key: 'default' }])
  expect(
    await store.getState().listJiraIssues('all', 50, { filters: { statuses: ['Open'] } })
  ).toMatchObject([{ key: 'Open' }])
  expect(await store.getState().listJiraIssues('all', 50)).toMatchObject([{ key: 'default' }])
  expect(
    await store
      .getState()
      .listJiraIssues('all', 50, { filters: { statuses: ['In Progress', 'Blocked'] } })
  ).toMatchObject([{ key: 'Blocked-In Progress' }])
  await store
    .getState()
    .listJiraIssues('all', 50, { filters: { statuses: ['Blocked', 'In Progress'] } })
  expect(list).toHaveBeenCalledTimes(3)
})
