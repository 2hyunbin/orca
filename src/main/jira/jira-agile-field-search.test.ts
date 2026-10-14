import { describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { searchIssues } from './jira-issue-search'
import { getIssue } from './jira-issue-read'

const { getClientsMock, jiraRequestMock } = vi.hoisted(() => ({
  getClientsMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))
vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClientsMock(...args),
  clearToken: vi.fn(),
  isAuthError: () => false
}))
vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

function client(id: string): JiraClientForSite {
  return {
    site: {
      id,
      siteUrl: `https://${id}.atlassian.net`,
      email: '',
      displayName: id,
      accountId: 'viewer'
    },
    authorization: 'Basic fixture'
  }
}

describe('planning fields in Jira searches', () => {
  it('requests all discovered points fields and maps the populated project field', async () => {
    getClientsMock.mockReturnValue([client('field-request-site')])
    jiraRequestMock.mockImplementation(async (_entry, path) =>
      path.endsWith('/field')
        ? [
            {
              id: 'customfield_7',
              name: 'Sprint',
              schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
            },
            {
              id: 'customfield_8',
              name: 'Story Points',
              schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
            },
            {
              id: 'customfield_9',
              name: 'Story point estimate',
              schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' }
            }
          ]
        : {
            issues: [
              {
                id: '1',
                key: 'DEMO-1',
                fields: {
                  summary: 'Planning',
                  customfield_7: [{ name: 'Sprint 2', state: 'active' }],
                  customfield_8: null,
                  customfield_9: 0,
                  timeoriginalestimate: 3600,
                  timeestimate: 0,
                  parent: { key: 'DEMO-10', fields: { summary: 'Epic' } }
                }
              }
            ]
          }
    )
    const issues = await searchIssues('project = DEMO', 30, 'field-request-site')
    expect(issues[0]).toMatchObject({
      sprint: 'Sprint 2',
      storyPoints: 0,
      originalEstimateSeconds: 3600,
      remainingEstimateSeconds: 0,
      parent: { key: 'DEMO-10', title: 'Epic' }
    })
    const init = jiraRequestMock.mock.calls.find((call) => call[1].endsWith('/search/jql'))?.[2]
    expect(JSON.parse(init.body).fields).toEqual(
      expect.arrayContaining([
        'parent',
        'timeoriginalestimate',
        'timeestimate',
        'customfield_7',
        'customfield_8',
        'customfield_9'
      ])
    )
  })

  it('does not deadlock when more sites than queue slots discover fields together', async () => {
    const clients = Array.from({ length: 6 }, (_, index) => client(`queue-site-${index}`))
    getClientsMock.mockReturnValue(clients)
    jiraRequestMock
      .mockClear()
      .mockImplementation(async (_entry, path) =>
        path.endsWith('/field')
          ? []
          : { issues: [{ key: 'DEMO-1', fields: { summary: 'Planning' } }] }
      )
    expect(await searchIssues('project = DEMO', 30, 'all')).toHaveLength(6)
    expect(jiraRequestMock).toHaveBeenCalledTimes(12)
  })

  it('preserves planning fields when a list issue is hydrated from its detail read', async () => {
    getClientsMock.mockReturnValue([client('detail-field-site')])
    jiraRequestMock.mockClear().mockImplementation(async (_entry, path) =>
      path.endsWith('/field')
        ? [
            {
              id: 'customfield_4',
              name: 'Sprint',
              schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' }
            },
            {
              id: 'customfield_5',
              name: 'Points',
              schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' }
            }
          ]
        : {
            id: '1',
            key: 'DEMO-1',
            fields: {
              summary: 'Planning',
              description: 'Detailed planning notes',
              customfield_4: [{ name: 'Sprint 3', state: 'active' }],
              customfield_5: 0,
              timeoriginalestimate: 7200,
              timeestimate: 0,
              parent: { key: 'DEMO-10', fields: { summary: 'Epic' } }
            }
          }
    )
    expect(await getIssue('DEMO-1', 'detail-field-site')).toMatchObject({
      description: 'Detailed planning notes',
      sprint: 'Sprint 3',
      storyPoints: 0,
      originalEstimateSeconds: 7200,
      remainingEstimateSeconds: 0,
      parent: { key: 'DEMO-10', title: 'Epic' }
    })
    const detailPath = jiraRequestMock.mock.calls.find((call) => call[1].includes('/issue/'))?.[1]
    const fields = new URL(detailPath, 'https://example.atlassian.net').searchParams.get('fields')
    expect(fields?.split(',')).toEqual(
      expect.arrayContaining(['description', 'customfield_4', 'customfield_5'])
    )
  })
})
