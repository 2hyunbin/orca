// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskPageJiraIssueUserField } from './IssueUserField'
import { buildJiraCreateSubmission } from '@/components/task-page-jira-create-fields'
import type { JiraCreateField } from '../../../../../shared/jira-types'

const search = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraSearchUsers: search }))
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
    const siteId = 'site-1'
    const submit = vi.fn()
    search.mockResolvedValue([{ accountId: id, displayName: 'Ada Lovelace' }])
    function Form() {
      const [value, setValue] = useState('')
      return (
        <>
          <TaskPageJiraIssueUserField
            providerSettings={{ kind: 'local' }}
            siteId={siteId}
            value={value}
            onChange={setValue}
            disabled={false}
            label={field.name}
          />
          <button
            disabled={!value}
            onClick={() => submit(buildJiraCreateSubmission([field], { [field.key]: value }))}
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
    expect(search).toHaveBeenCalledWith({ kind: 'local' }, 'Ada Lovelace', siteId)
    expect(screen.getByRole('button', { name: 'Reporter' }).textContent).toBe('Ada Lovelace')
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }))
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        customFields: { [field.key]: id },
        userFieldKeys: [field.key]
      })
    )
  }
)
