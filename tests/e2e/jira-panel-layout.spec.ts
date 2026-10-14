import type { JiraIssue } from '../../src/shared/jira-types'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const ISSUE_TITLE = 'Keep planning notes visible while switching between project tasks'
const ISSUE: JiraIssue = {
  id: 'layout-fixture',
  key: 'DEMO-101',
  siteId: 'layout-site',
  title: ISSUE_TITLE,
  url: 'https://example.atlassian.net/browse/DEMO-101',
  project: { id: 'layout-project', key: 'DEMO', name: 'Demo' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  priority: { id: 'high', name: 'High' },
  assignee: { accountId: 'layout-user', displayName: 'Demo User' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z'
}

test('Jira titles and sort headings adapt to panel width inside a wide window', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1500, height: 900 })
  await orcaPage.evaluate((issue) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    if (!state.settings) {
      throw new Error('Settings unavailable')
    }
    const status = {
      connected: true,
      viewer: null,
      selectedSiteId: 'layout-site',
      sites: [
        {
          id: 'layout-site',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          displayName: 'Demo Jira',
          accountId: 'layout-user'
        }
      ]
    }
    store.setState({
      settings: { ...state.settings, defaultTaskSource: 'jira', visibleTaskProviders: ['jira'] },
      jiraStatus: status,
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0',
      checkJiraConnection: async () => {},
      readJiraStatus: async () => status,
      listJiraIssues: async () => [issue],
      searchJiraIssues: async () => [issue]
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  }, ISSUE)

  const title = orcaPage.getByRole('heading', { name: ISSUE_TITLE })
  await expect(title).toBeVisible()
  for (const width of [500, 780, 1050, 1320]) {
    await title.evaluate((element, width) => {
      const host =
        element.closest('[role="button"]')?.parentElement?.parentElement?.parentElement
          ?.parentElement?.parentElement
      if (!(host instanceof HTMLElement)) {
        throw new Error('Jira list host unavailable')
      }
      host.style.width = `${width}px`
      host.style.maxWidth = 'none'
    }, width)
    await expect
      .poll(() => title.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(200)
    const mobileSort = orcaPage.getByTestId('jira-mobile-sort-controls')
    const assignee = orcaPage.getByRole('button', { name: 'Assignee', exact: true })
    await (width < 768 ? expect(mobileSort).toBeVisible() : expect(mobileSort).toBeHidden())
    await (width >= 1024 ? expect(assignee).toBeVisible() : expect(assignee).toBeHidden())
    if (width >= 768) {
      const grids = await title.evaluate((element) => {
        const row = element.closest('[role="button"]')
        const host = row?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement
        const header = host?.children[1]
        if (!row || !header) {
          throw new Error('Jira header or row unavailable')
        }
        return [
          getComputedStyle(row).gridTemplateColumns.split(' '),
          getComputedStyle(header).gridTemplateColumns.split(' ')
        ]
      })
      // The scroll gutter narrows the flexible title; fixed tracks must still match.
      expect(grids[0].filter((_, index) => index !== 1)).toEqual(
        grids[1].filter((_, index) => index !== 1)
      )
    }
  }
})
