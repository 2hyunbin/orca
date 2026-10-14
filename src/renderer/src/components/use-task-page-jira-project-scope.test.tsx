// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { useTaskPageJiraProjectScope } from './use-task-page-jira-project-scope'
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  defaultJiraProject: project,
  kind: 'folder'
}
afterEach(cleanup)
describe('repository-scoped Jira Tasks', () => {
  it('uses an explicit folder repository default and allows the All-project override', () => {
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope([repo], [], 'repo', 'local', 'all')
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
    act(() => result.current.setJiraProjectFilter(null))
    expect(result.current.jiraProjectFilter).toBeNull()
    expect(repo.defaultJiraProject).toEqual(project)
  })
  it('does not apply another site or execution host’s project mapping', () => {
    const initialProps: { host: ExecutionHostId; site: string } = { host: 'local', site: 'site-b' }
    const { result, rerender } = renderHook(
      ({ host, site }) => useTaskPageJiraProjectScope([repo], [repo], 'repo', host, site),
      { initialProps }
    )
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ host: 'runtime:remote', site: 'site-a' })
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ host: 'local', site: 'site-a' })
    expect(result.current.jiraProjectFilter).toEqual(project)
  })
})
