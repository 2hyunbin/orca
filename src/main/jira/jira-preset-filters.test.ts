import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssueFilter } from '../../shared/jira-types'
import type { JiraClientForSite } from './authenticated-request'

const { getClients, jiraRequest, clearToken } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn(),
  clearToken: vi.fn()
}))
vi.mock('./client', () => ({ getClients, clearToken, isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest,
  JiraApiError: class extends Error {}
}))
vi.mock('./request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))

function site(id: string, authType: 'cloud' | 'server' = 'cloud'): JiraClientForSite {
  return {
    site: {
      id,
      authType,
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: id,
      accountId: 'me'
    },
    authorization: 'fixture'
  }
}

function issue(key: string, done: boolean, resolved: boolean, updated = '2020-01-01') {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      updated,
      status: {
        name: done ? 'Complete' : 'Reopened',
        statusCategory: { key: done ? 'done' : 'indeterminate' }
      },
      resolution: resolved ? { name: 'Fixed' } : null
    }
  }
}

function requestJql(init: { body?: string } | undefined): string {
  const body: unknown = JSON.parse(init?.body ?? '{}')
  if (
    typeof body !== 'object' ||
    body === null ||
    !('jql' in body) ||
    typeof body.jql !== 'string'
  ) {
    throw new Error('Expected search body')
  }
  return body.jql
}

describe('Jira preset filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([site('cloud')])
    jiraRequest.mockReset()
  })

  it.each<JiraIssueFilter>(['assigned', 'reported', 'done'])(
    '%s follows status when resolution is stale',
    async (filter) => {
      const fixtures = [issue('ALP-1', true, false), issue('ALP-2', false, true)]
      jiraRequest.mockImplementation(async (_entry, _path, init) => {
        const jql = requestJql(init)
        return {
          issues: fixtures.filter((item) => {
            if (jql.includes('statusCategory = Done')) {
              return item.fields.status.statusCategory.key === 'done'
            }
            if (jql.includes('statusCategory != Done')) {
              return item.fields.status.statusCategory.key !== 'done'
            }
            return jql.includes('IS NOT EMPTY')
              ? item.fields.resolution !== null
              : item.fields.resolution === null
          })
        }
      })
      const { listIssues } = await import('./jira-issue-search')
      await expect(listIssues(filter, 20, 'cloud')).resolves.toMatchObject([
        { key: filter === 'done' ? 'ALP-1' : 'ALP-2' }
      ])
    }
  )

  it('bounds Cloud All with every project, preserving old open issues', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return path.includes('startAt=0')
          ? { maxResults: 1, total: 2, values: [{ id: '10', key: 'ALP' }] }
          : { maxResults: 1, total: 2, values: [{ id: '20', key: 'BRV' }] }
      }
      const jql = requestJql(init)
      if (!jql.includes('project in (')) {
        throw new Error('Unbounded JQL queries are not allowed here')
      }
      expect(jql).toContain('statusCategory != Done')
      expect(jql).toContain('"10"')
      expect(jql).toContain('"20"')
      expect(jql).not.toMatch(/updated\s*[><=]|resolution/)
      return { issues: [issue('ALP-2', false, true)] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).resolves.toMatchObject([
      { key: 'ALP-2', updatedAt: '2020-01-01' }
    ])
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it('keeps Server/DC All on classic search without project discovery', async () => {
    getClients.mockReturnValue([site('server', 'server')])
    jiraRequest.mockResolvedValue({ issues: [] })
    const { listIssues } = await import('./jira-issue-search')
    await listIssues('all', 20, 'server')
    expect(jiraRequest).toHaveBeenCalledWith(
      expect.anything(),
      '/rest/api/2/search',
      expect.objectContaining({
        body: expect.stringContaining('statusCategory != Done ORDER BY updated DESC')
      })
    )
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('does not send an unbounded search when the Cloud account has no projects', async () => {
    jiraRequest.mockResolvedValue({ values: [], isLast: true })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).resolves.toEqual([])
    expect(jiraRequest).toHaveBeenCalledTimes(1)
    expect(jiraRequest.mock.calls[0][1]).toContain('/project/search')
  })

  it('surfaces project discovery failures instead of returning an empty list', async () => {
    jiraRequest.mockImplementation(async (_entry, path) => {
      if (path.includes('/project/search')) {
        throw new Error('Project discovery forbidden')
      }
      return { issues: [] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).rejects.toThrow('Project discovery forbidden')
  })

  it('leaves caller JQL unchanged even when it equals the All preset', async () => {
    jiraRequest.mockResolvedValue({ issues: [] })
    const { searchIssues } = await import('./jira-issue-search')
    const jql = 'statusCategory != Done ORDER BY updated DESC'
    await searchIssues(jql, 20, 'cloud')
    expect(requestJql(jiraRequest.mock.calls[0][2])).toBe(jql)
    expect(jiraRequest).toHaveBeenCalledTimes(1)
  })

  it('merges project batches by update time before applying the result limit', async () => {
    jiraRequest.mockImplementation(async (_entry, path, init) => {
      if (path.includes('/project/search')) {
        return {
          isLast: true,
          values: Array.from({ length: 101 }, (_, index) => ({ id: String(index) }))
        }
      }
      return {
        issues: [
          requestJql(init).includes('"100"')
            ? issue('LAST-1', false, false, '2026-10-01')
            : issue('FIRST-1', false, false, '2020-01-01')
        ]
      }
    })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 1, 'cloud')).resolves.toMatchObject([{ key: 'LAST-1' }])
    expect(jiraRequest).toHaveBeenCalledTimes(3)
  })

  it('restricts projects separately for each Cloud site while keeping Server search unchanged', async () => {
    getClients.mockReturnValue([site('a'), site('b'), site('server', 'server')])
    const queries = new Map<string, string>()
    jiraRequest.mockImplementation(async (entry: JiraClientForSite, path: string, init) => {
      if (path.includes('/project/search')) {
        return { isLast: true, values: [{ id: entry.site.id }] }
      }
      queries.set(entry.site.id, requestJql(init))
      return { issues: [] }
    })
    const { listIssues } = await import('./jira-issue-search')
    await listIssues('all', 20, 'all')
    expect(queries.get('a')).toBe(
      'project in ("a") AND statusCategory != Done ORDER BY updated DESC'
    )
    expect(queries.get('b')).toBe(
      'project in ("b") AND statusCategory != Done ORDER BY updated DESC'
    )
    expect(queries.get('server')).toBe('statusCategory != Done ORDER BY updated DESC')
  })

  it.each([{ total: 2, values: [] }, { isLast: false, values: [] }, { issues: [] }])(
    'surfaces malformed or incomplete project discovery: %j',
    async (response) => {
      jiraRequest.mockResolvedValue(response)
      const { listIssues } = await import('./jira-issue-search')
      await expect(listIssues('all', 20, 'cloud')).rejects.toThrow(/project page/)
      expect(jiraRequest).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects page-limit exhaustion instead of silently omitting projects', async () => {
    jiraRequest.mockResolvedValue({ isLast: false, maxResults: 1, values: [{ id: '10' }] })
    const { listIssues } = await import('./jira-issue-search')
    await expect(listIssues('all', 20, 'cloud')).rejects.toThrow('exceeded the page limit')
    expect(jiraRequest).toHaveBeenCalledTimes(100)
  })

  it('puts project discovery under the same abortable deadline as issue search', async () => {
    vi.useFakeTimers()
    try {
      jiraRequest.mockImplementation(
        (_entry, _path, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
      )
      const { listIssues } = await import('./jira-issue-search')
      const result = listIssues('all', 20, 'cloud').then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(jiraRequest).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
