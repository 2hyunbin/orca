// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraIssueUserField } from './IssueUserField'
import { buildJiraCreateSubmission } from '@/components/task-page-jira-create-fields'
import { createIssue } from '../../../../../main/jira/jira-issue-mutations'
import type { JiraCreateField, JiraSite } from '../../../../../shared/jira-types'

const { search, request, clients } = vi.hoisted(() => ({
  search: vi.fn(),
  request: vi.fn(),
  clients: vi.fn()
}))
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraSearchUsers: search }))
vi.mock('../../../../../main/jira/client', () => ({
  getClients: clients,
  isAuthError: () => false
}))
vi.mock('../../../../../main/jira/request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))
vi.mock('../../../../../main/jira/authenticated-request', () => ({
  apiBasePath: () => '/rest/api/issue-test',
  jiraRequest: request
}))
afterEach(cleanup)

it.each(['cloud', 'server'] as const)(
  'submits a picked required user as a %s identity, never the search text',
  async (authType) => {
    const id = authType === 'server' ? 'ada.login' : 'account-123'
    const field: JiraCreateField = {
      key: authType === 'server' ? 'customfield_9' : 'reporter',
      name: 'Reporter',
      required: true,
      schema: { type: 'user' },
      allowedValues: [{ id, name: 'Ada Lovelace' }]
    }
    const site: JiraSite = {
      id: 'site-1',
      siteUrl: 'https://jira.example.com',
      displayName: 'Jira',
      email: '',
      accountId: 'me',
      authType: authType === 'server' ? 'server' : undefined
    }
    clients.mockReturnValue([{ site }])
    search.mockResolvedValue([{ accountId: id, displayName: 'Ada Lovelace' }])
    request.mockReset().mockResolvedValue({ id: '1', key: 'ENG-1' })
    function Form() {
      const [value, setValue] = useState('')
      return (
        <>
          <TaskPageJiraIssueUserField
            providerSettings={{ kind: 'local' }}
            siteId={site.id}
            value={value}
            onChange={setValue}
            disabled={false}
            label={field.name}
          />
          <button
            disabled={!value}
            onClick={() =>
              void createIssue({
                siteId: site.id,
                projectId: '100',
                issueTypeId: '1',
                title: 'Example',
                ...buildJiraCreateSubmission([field], { [field.key]: value })
              })
            }
          >
            Create issue
          </button>
        </>
      )
    }
    render(<Form />)
    fireEvent.click(screen.getByRole('button', { name: 'Reporter' }))
    fireEvent.change(screen.getByPlaceholderText('Search users'), {
      target: { value: 'Ada Lovelace' }
    })
    expect(screen.getByRole('button', { name: 'Create issue' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Ada Lovelace' }))
    expect(search).toHaveBeenCalledWith({ kind: 'local' }, 'Ada Lovelace', site.id)
    expect(screen.getByRole('button', { name: 'Reporter' }).textContent).toBe('Ada Lovelace')
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ site }, expect.any(String), {
        method: 'POST',
        body: JSON.stringify({
          fields: {
            project: { id: '100' },
            issuetype: { id: '1' },
            summary: 'Example',
            [field.key]: authType === 'server' ? { name: id } : { accountId: id }
          }
        })
      })
    )
  }
)
