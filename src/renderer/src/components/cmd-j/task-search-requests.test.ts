import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createCmdJTaskSearchRequests } from './task-search-requests'
import { jiraTaskIssue } from './task-search.test-fixture'
import { makeRepo } from '../worktree-jump-palette-test-fixtures'
import { linearSearchIssues, linearStatus } from '@/runtime/runtime-linear-client'
import { createRuntimeGitLabApi } from '@/runtime/runtime-gitlab-api'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearStatus: vi.fn(),
  linearSearchIssues: vi.fn()
}))
vi.mock('@/runtime/gitlab-owner-api', () => ({ gitLabApiFor: vi.fn() }))
const initial = useAppStore.getInitialState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.resetAllMocks()
})
function requests(
  providers: ('jira' | 'linear' | 'github' | 'gitlab')[],
  hostIds: string[] = [],
  repos = [makeRepo()],
  repoIds: string[] = []
) {
  return createCmdJTaskSearchRequests({
    query: 'login redirect',
    settings: createGlobalSettingsFixture({ visibleTaskProviders: providers }),
    repos,
    filter: { hostIds, repoIds },
    hostLabels: new Map(),
    signal: new AbortController().signal
  })
}

it('binds Jira results to the returned account rather than the active site', async () => {
  const search = vi.fn().mockResolvedValue([jiraTaskIssue])
  useAppStore.setState({
    readJiraStatus: vi.fn().mockResolvedValue({
      connected: true,
      selectedSiteId: 'all',
      sites: [
        { id: 'other-site', siteUrl: 'https://other.atlassian.net', email: 'other@example.com' }
      ]
    }),
    searchJiraIssues: search
  })
  const result = await requests(['jira'])[0]?.run()
  expect(result?.[0]?.sourceContext).toMatchObject({
    hostId: 'local',
    accountLabel: 'other@example.com',
    providerIdentity: { siteId: 'other-site', projectKey: 'DEMO' }
  })
  expect(search).toHaveBeenCalledWith(
    'text ~ "login redirect*"',
    12,
    expect.objectContaining({ siteId: 'all' })
  )
})

it('scopes Linear queries to the explicit runtime and selected workspace', async () => {
  vi.mocked(linearStatus).mockResolvedValue({
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'workspace-a'
  })
  vi.mocked(linearSearchIssues).mockResolvedValue([])
  await requests(['linear'], ['runtime:source'], [])[0]?.run()
  expect(linearSearchIssues).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'runtime:source' }),
    'login redirect',
    12,
    'workspace-a'
  )
  expect(requests(['linear', 'jira'], ['ssh:remote'], [])).toMatchObject([
    { id: 'jira:local', provider: 'jira' }
  ])
})

it('searches desktop-owned Jira for an SSH repository filter and retains the repository seed', async () => {
  const status = vi.fn().mockResolvedValue({ connected: true, selectedSiteId: 'other-site' })
  const search = vi.fn().mockResolvedValue([jiraTaskIssue])
  useAppStore.setState({ readJiraStatus: status, searchJiraIssues: search })
  const remoteRepo = { ...makeRepo(), id: 'remote-repo', executionHostId: 'ssh:remote' as const }
  for (const hostIds of [['ssh:remote'], []]) {
    const scoped = requests(['jira'], hostIds, [makeRepo(), remoteRepo], [remoteRepo.id])
    expect(scoped).toHaveLength(1)
    const results = await scoped[0]?.run()
    expect(results?.[0]).toMatchObject({
      initialRepoId: remoteRepo.id,
      sourceContext: { hostId: 'local', repoId: remoteRepo.id }
    })
  }
  expect(status).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'local', repoId: remoteRepo.id })
  )
  expect(search).toHaveBeenCalledWith(
    'text ~ "login redirect*"',
    12,
    expect.objectContaining({ sourceContext: expect.objectContaining({ hostId: 'local' }) })
  )
})

it('queries Jira once per credential host while preserving runtime ownership', async () => {
  const status = vi.fn().mockResolvedValue({ connected: true })
  const search = vi.fn().mockResolvedValue([])
  useAppStore.setState({ readJiraStatus: status, searchJiraIssues: search })
  const scoped = requests(['jira'], ['ssh:first', 'local', 'ssh:second', 'runtime:source'], [])
  expect(scoped.map((request) => request.id)).toEqual(['jira:local', 'jira:runtime:source'])
  await Promise.all(scoped.map((request) => request.run()))
  expect(status).toHaveBeenCalledTimes(2)
  expect(status).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'runtime:source' }))
  expect(search).toHaveBeenCalledTimes(2)
})

it('routes GitHub search through the repo owner with an open-issue query', async () => {
  const fetch = vi.fn().mockResolvedValue([])
  useAppStore.setState({ fetchWorkItems: fetch, preflightStatusChecked: false })
  const repo = { ...makeRepo(), executionHostId: 'runtime:forge' as const }
  await requests(['github'], ['runtime:forge'], [repo])[0]?.run()
  expect(fetch).toHaveBeenCalledWith(
    repo.id,
    repo.path,
    12,
    'is:issue is:open login redirect',
    expect.objectContaining({
      sourceContext: expect.objectContaining({ hostId: 'runtime:forge', repoId: repo.id })
    })
  )
})

it('uses GitLab combined search and never includes merge requests in task results', async () => {
  const listWorkItems = vi.fn().mockResolvedValue({
    items: [{ type: 'mr', number: 1, title: 'login redirect', state: 'opened' }]
  })
  vi.mocked(gitLabApiFor).mockReturnValue({
    ...createRuntimeGitLabApi({
      call: async () => {
        throw new Error('Unexpected GitLab call')
      },
      supportsCapability: async () => false
    }),
    listWorkItems
  })
  useAppStore.setState({ preflightStatusChecked: false })
  const repo = { ...makeRepo(), connectionId: 'remote' }
  const result = await requests(['gitlab'], ['ssh:remote'], [repo])[0]?.run()
  expect(gitLabApiFor).toHaveBeenCalledWith(
    expect.objectContaining({
      repoOwnerExecutionHostId: 'ssh:remote',
      sourceContext: expect.objectContaining({ hostId: 'ssh:remote' })
    })
  )
  expect(listWorkItems).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'opened', query: 'login redirect', perPage: 12 })
  )
  expect(result).toEqual([])
})

it('does not search disconnected account integrations or folder repositories', async () => {
  vi.mocked(linearStatus).mockResolvedValue({ connected: false, viewer: null })
  useAppStore.setState({
    readJiraStatus: vi.fn().mockResolvedValue({ connected: false }),
    searchJiraIssues: vi.fn()
  })
  for (const request of requests(['linear', 'jira'])) {
    expect(await request.run()).toEqual([])
  }
  expect(linearSearchIssues).not.toHaveBeenCalled()
  expect(useAppStore.getState().searchJiraIssues).not.toHaveBeenCalled()
  expect(requests(['github', 'gitlab'], [], [{ ...makeRepo(), kind: 'folder' }])).toEqual([])
})
