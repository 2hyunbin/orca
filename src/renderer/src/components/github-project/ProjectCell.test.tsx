// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeItem,
  type RawItem
} from '../../../../main/github/project-view/project-view-item-normalization'
import { fetchItemsPageWithRaw } from '../../../../main/github/project-view/project-view-item-page'
import { ghExecFileAsync } from '../../../../main/github/project-view/internals'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import ProjectCell from './ProjectCell'
import { fetchAllItems } from '../../../../main/github/project-view/project-view-items'
import { _resetProjectViewCachesForTests } from '../../../../main/github/project-view/project-view-cache'

vi.mock('../../../../main/github/project-view/internals', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: vi.fn(),
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  projectGhExecOptions: (host?: string) => ({ host }),
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))
vi.mock('../../../../main/github/project-view/project-view-config', () => ({
  ownerQueryRoot: () => 'organization'
}))

const item: RawItem = {
  id: 'item-1',
  type: 'ISSUE',
  content: {
    __typename: 'Issue',
    number: 42,
    title: 'Parent issue',
    subIssuesSummary: { completed: 1, total: 2, percentCompleted: 50 }
  },
  fieldValues: {
    nodes: [
      {
        __typename: 'ProjectV2ItemFieldPullRequestValue',
        field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
        pullRequests: {
          totalCount: 12,
          nodes: Array.from({ length: 10 }, (_, index) => ({
            number: index + 1,
            title: `Change ${index + 1}`,
            url: `https://github.com/o/r/pull/${index + 1}`
          }))
        }
      }
    ]
  }
}
const args = {
  owner: 'o',
  ownerType: 'organization',
  projectNumber: 1,
  query: '',
  first: 50,
  after: null,
  includeParent: true,
  host: 'acme.ghe.com'
} as const

beforeEach(() => {
  vi.clearAllMocks()
  _resetProjectViewCachesForTests()
  vi.mocked(ghExecFileAsync).mockResolvedValue({
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              totalCount: 1,
              pageInfo: { hasNextPage: false },
              nodes: [item]
            }
          }
        }
      }
    }),
    stderr: ''
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderColumns(raw: RawItem): void {
  const result = normalizeItem(raw, 0)
  if (!result.ok) {
    throw new Error('Expected a project row')
  }
  renderRowColumns(result.row)
}

function renderRowColumns(row: GitHubProjectRow): void {
  for (const [id, dataType] of [
    ['field-pr', 'LINKED_PULL_REQUESTS'],
    ['field-progress', 'SUB_ISSUES_PROGRESS']
  ] as const) {
    render(
      <ProjectCell
        row={row}
        field={{ kind: 'field', id, name: dataType, dataType }}
        editable={false}
        sourceTarget={{ kind: 'local' }}
      />
    )
  }
}

describe('Project columns from the items response', () => {
  it.each(['#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 +2', '1/2 (50%)'])(
    'renders %s from the existing items request',
    async (expectedText) => {
      const page = await fetchItemsPageWithRaw(args)
      if (!page.ok || !page.page.nodes?.[0]) {
        throw new Error('Expected an items page')
      }
      renderColumns(page.page.nodes[0])
      expect(screen.getByText(expectedText).textContent).toBe(expectedText)
      expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
      const query = vi.mocked(ghExecFileAsync).mock.calls[0][0].join(' ')
      expect(query).toContain('... on ProjectV2ItemFieldPullRequestValue')
      expect(query).toContain('pullRequests(first:10)')
      expect(query).toContain('subIssuesSummary { completed total percentCompleted }')
      expect(query).not.toContain('ProjectV2ItemFieldProgressValue')
    }
  )

  it('keeps unsupported or absent summaries blank for old hosts, drafts and empty parents', () => {
    renderColumns({ id: 'old-host', type: 'ISSUE', content: { title: 'Old host' } })
    renderColumns({ id: 'draft', type: 'DRAFT_ISSUE', content: { title: 'Draft' } })
    renderColumns({
      id: 'empty',
      type: 'ISSUE',
      content: {
        subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }
      }
    })
    expect(document.body.textContent).toBe('')
  })

  it.each([
    {
      extensions: { code: 'undefinedField' },
      message: "Field 'subIssuesSummary' doesn't exist on type 'Issue'"
    },
    {
      extensions: { code: 'undefinedType' },
      message:
        "No such type ProjectV2ItemFieldPullRequestValue, so it can't be a fragment condition"
    },
    { type: 'FIELD_NOT_FOUND', path: ['parent'] }
  ])('retries an unsupported optional selection once: %j', async (error) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ghExecFileAsync)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ errors: [error] }),
        stderr: ''
      })
      .mockResolvedValue({
        stdout: JSON.stringify({
          data: {
            organization: {
              projectV2: {
                items: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false },
                  nodes: [{ id: 'old-server', type: 'ISSUE', content: { title: 'Old server' } }]
                }
              }
            }
          }
        }),
        stderr: ''
      })
    const result = await fetchAllItems(args)
    if (!result.ok) {
      throw new Error('Expected the fallback items query to succeed')
    }
    expect(result.parentFieldDropped).toBe(true)
    renderRowColumns(result.rows[0])
    expect(document.body.textContent).toBe('')
    expect(ghExecFileAsync).toHaveBeenCalledTimes(2)
    const queries = vi
      .mocked(ghExecFileAsync)
      .mock.calls.map(([arguments_]) => arguments_.join(' '))
    expect(queries[0]).toContain('subIssuesSummary')
    expect(queries[0]).toContain('ProjectV2ItemFieldPullRequestValue')
    expect(queries[1]).not.toContain('subIssuesSummary')
    expect(queries[1]).not.toContain('ProjectV2ItemFieldPullRequestValue')
    expect(queries[1]).not.toContain('parent {')
    await fetchAllItems(args)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(3)
    expect(vi.mocked(ghExecFileAsync).mock.calls[2][0].join(' ')).not.toContain('subIssuesSummary')
  })

  it('keeps unrelated API failures instead of treating them as schema capabilities', async () => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({
        errors: [{ type: 'FORBIDDEN', message: 'Cannot access subIssuesSummary' }]
      }),
      stderr: ''
    })
    expect(await fetchAllItems(args)).toMatchObject({ ok: false })
    expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
  })
})
