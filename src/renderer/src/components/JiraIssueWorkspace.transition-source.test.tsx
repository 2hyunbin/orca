// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  transitions: vi.fn(),
  settings: { activeRuntimeEnvironmentId: 'environment-a' }
}))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      settings: { activeRuntimeEnvironmentId: string }
      patchJiraIssue: () => void
    }) => unknown
  ) =>
    selector({
      settings: mocks.settings,
      patchJiraIssue: () => {}
    })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => values?.[key] ?? '')
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssue: async () => null,
  jiraIssueComments: async () => [],
  jiraListTransitions: mocks.transitions,
  jiraListPriorities: async () => [],
  jiraListAssignableUsers: async () => [],
  jiraUpdateIssue: mocks.update,
  jiraAddIssueComment: async () => ({ ok: true })
}))
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Sheet: Content, SheetContent: Content, SheetTitle: Content, SheetDescription: Content }
})
vi.mock('./jira-issue-workspace-chrome', async (importOriginal) => {
  const actual = await importOriginal<{ JiraIssueMetadataBar: typeof JiraIssueMetadataBar }>()
  return {
    JiraIssueWorkspaceHeader: () => null,
    JiraIssueMetadataBar: (props: ComponentProps<typeof JiraIssueMetadataBar>) => (
      <actual.JiraIssueMetadataBar {...props} />
    )
  }
})
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: () => null,
  JiraIssueCommentComposer: () => null
}))
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'runtime:environment-a',
  accountLabel: 'Account A',
  providerIdentity: { provider: 'jira', siteId: 'site-a', projectKey: 'APP' }
}
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://example.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
function transition(id: string): JiraTransition {
  return {
    id,
    name: 'Close',
    to: { ...issue.status, id: 'done', name: 'Done' },
    fields: [{ key: 'comment', name: 'Comment', required: true }]
  }
}
async function waitForTransitions(): Promise<void> {
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Change status: Open' })
        .querySelector('.lucide-chevron-down')
    ).not.toBeNull()
  )
}
async function openForm(): Promise<void> {
  await waitForTransitions()
  fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  await screen.findByLabelText('Comment')
}
function workspace(context?: TaskSourceContext) {
  return (
    <JiraIssueWorkspace issue={issue} sourceContext={context} onUse={() => {}} onClose={() => {}} />
  )
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings = { activeRuntimeEnvironmentId: 'environment-a' }
  mocks.transitions.mockResolvedValue([transition('old')])
  mocks.update.mockResolvedValue({ ok: true })
})
describe('Jira transition form source ownership', () => {
  it.each([
    { label: 'host', next: { ...source, hostId: 'runtime:environment-b' } },
    { label: 'project', next: { ...source, projectId: 'project-b' } },
    { label: 'account', next: { ...source, accountLabel: 'Account B' } },
    {
      label: 'provider identity',
      next: {
        ...source,
        providerIdentity: { provider: 'jira', siteId: 'site-b', projectKey: 'APP' }
      }
    }
  ] satisfies { label: string; next: TaskSourceContext }[])(
    'drops an old required-field form when the $label changes for the same site and key',
    async ({ next }) => {
      const view = render(workspace(source))
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Old source draft' } })
      mocks.transitions.mockResolvedValue([transition('new')])
      view.rerender(workspace(next))
      await waitForTransitions()
      expect(screen.queryByLabelText('Comment')).toBeNull()
      expect(mocks.update).not.toHaveBeenCalled()
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), {
        target: { value: 'New source comment' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith(
          next,
          issue.key,
          { transitionId: 'new', transitionComment: 'New source comment' },
          'site-a'
        )
      )
    }
  )
  it('drops the form when a source without a selected project changes execution host', async () => {
    const view = render(workspace())
    await openForm()
    mocks.settings = { activeRuntimeEnvironmentId: 'environment-b' }
    view.rerender(workspace())
    await waitForTransitions()
    expect(screen.queryByLabelText('Comment')).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
