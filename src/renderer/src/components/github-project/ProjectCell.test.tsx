// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeItem,
  type RawItem
} from '../../../../main/github/project-view/project-view-item-normalization'
import { fetchItemsPageWithRaw } from '../../../../main/github/project-view/project-view-item-page'
import { fetchAllItems } from '../../../../main/github/project-view/project-view-items'
import {
  _resetProjectViewCachesForTests,
  type OptionalProjectItemField
} from '../../../../main/github/project-view/project-view-cache'
import { ghExecFileAsync } from '../../../../main/github/project-view/internals'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import ProjectCell from './ProjectCell'

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

const parent = { number: 10, title: 'Parent', url: 'https://github.com/o/r/issues/10' }
const item: RawItem = {
  id: 'item-1',
  type: 'ISSUE',
  content: {
    __typename: 'Issue',
    number: 42,
    title: 'Issue',
    parent,
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
  first: 100,
  after: null,
  unsupportedFields: new Set<OptionalProjectItemField>(),
  host: 'acme.ghe.com'
} as const
const prText = '#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 +2'
const missingSummary = {
  extensions: { code: 'undefinedField', typeName: 'Issue', fieldName: 'subIssuesSummary' },
  message: "Field 'subIssuesSummary' doesn't exist on type 'Issue'"
}
const missingPrs = {
  extensions: { code: 'undefinedType', typeName: 'ProjectV2ItemFieldPullRequestValue' },
  message: "No such type ProjectV2ItemFieldPullRequestValue, so it can't be a fragment condition"
}
const missingParent = { type: 'FIELD_NOT_FOUND', path: ['parent'] }

function response(nodes: RawItem[]) {
  return {
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              totalCount: nodes.length,
              pageInfo: { hasNextPage: false },
              nodes
            }
          }
        }
      }
    }),
    stderr: ''
  }
}
function selectedResponse(arguments_: string[]) {
  const query = arguments_.join(' ')
  const content = { ...item.content }
  if (!query.includes('parent {')) {
    delete content.parent
  }
  if (!query.includes('subIssuesSummary {')) {
    delete content.subIssuesSummary
  }
  return response([
    {
      ...item,
      content,
      fieldValues: query.includes('... on ProjectV2ItemFieldPullRequestValue')
        ? item.fieldValues
        : { nodes: [] }
    }
  ])
}
beforeEach(() => {
  vi.clearAllMocks()
  _resetProjectViewCachesForTests()
  vi.mocked(ghExecFileAsync)
    .mockReset()
    .mockImplementation(async (arguments_) => selectedResponse(arguments_))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function normalized(raw: RawItem): GitHubProjectRow {
  const result = normalizeItem(raw, 0)
  if (!result.ok) {
    throw new Error('Expected a project row')
  }
  return result.row
}
function renderColumns(row: GitHubProjectRow): void {
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
  it.each([prText, '1/2 (50%)'])(
    'renders %s through one bounded items request on a named cloud host',
    async (expectedText) => {
      const page = await fetchItemsPageWithRaw(args)
      if (!page.ok || !page.page.nodes?.[0]) {
        throw new Error('Expected an items page')
      }
      const row = normalized(page.page.nodes[0])
      renderColumns(row)
      expect(screen.getByText(expectedText).textContent).toBe(expectedText)
      expect(row.fieldValuesByFieldId).toEqual({}) // Older sort/group consumers never receive a new value discriminant.
      expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
      const query = vi.mocked(ghExecFileAsync).mock.calls[0][0].join(' ')
      expect(query).toContain('pullRequests(first:10)')
      expect(query).toContain('subIssuesSummary { completed total percentCompleted }')
      expect(query).not.toContain('ProjectV2ItemFieldProgressValue')
    }
  )

  it.each([
    { completed: 0, total: 2, percentCompleted: 0 },
    { completed: 2, total: 2, percentCompleted: 100 }
  ])('preserves zero and complete counters: %j', (summary) => {
    renderColumns(normalized({ ...item, content: { subIssuesSummary: summary } }))
    expect(
      screen.getByText(`${summary.completed}/2 (${summary.percentCompleted}%)`).textContent
    ).toBeTruthy()
  })

  it('keeps old-host, draft, PR, redacted and zero-total rows blank', () => {
    for (const raw of [
      { id: 'old', type: 'ISSUE', content: {} },
      { id: 'draft', type: 'DRAFT_ISSUE', content: {} },
      { id: 'pr', type: 'PULL_REQUEST', content: {} },
      { id: 'redacted', type: 'REDACTED', content: null },
      {
        id: 'empty',
        type: 'ISSUE',
        content: { subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 } }
      }
    ]) {
      renderColumns(normalized(raw))
    }
    expect(document.body.textContent).toBe('')
  })

  it.each([
    { errors: [missingSummary], parentDropped: false, summary: false, prs: true },
    { errors: [missingPrs], parentDropped: false, summary: true, prs: false },
    { errors: [missingParent], parentDropped: true, summary: true, prs: true },
    { errors: [missingSummary, missingPrs], parentDropped: false, summary: false, prs: false },
    {
      errors: [{ message: "Cannot query field 'subIssuesSummary' on type 'Issue'." }],
      parentDropped: false,
      summary: false,
      prs: true
    }
  ])('omits only unsupported selections: %j', async ({ errors, parentDropped, summary, prs }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors }),
      stderr: ''
    })
    const result = await fetchAllItems(args)
    if (!result.ok) {
      throw new Error('Expected compatibility fallback to succeed')
    }
    expect(result.parentFieldDropped).toBe(parentDropped)
    expect(result.rows[0].content.parentIssue).toEqual(parentDropped ? null : parent)
    expect(warning).toHaveBeenCalledTimes(parentDropped ? 1 : 0)
    renderColumns(result.rows[0])
    expect(Boolean(screen.queryByText('1/2 (50%)'))).toBe(summary)
    expect(Boolean(screen.queryByText(prText))).toBe(prs)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(2)
    const query = vi.mocked(ghExecFileAsync).mock.calls[1][0].join(' ')
    expect(query.includes('parent {')).toBe(!parentDropped)
    expect(query.includes('subIssuesSummary {')).toBe(summary)
    expect(query.includes('... on ProjectV2ItemFieldPullRequestValue')).toBe(prs)
    await fetchAllItems(args)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(3)
    await fetchAllItems({ ...args, owner: 'another-owner' })
    expect(vi.mocked(ghExecFileAsync).mock.calls[3][0].join(' ')).toContain('subIssuesSummary {')
  })

  it('bounds sequential missing-field retries by the three optional selections', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const error of [missingSummary, missingPrs, missingParent]) {
      vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
        stdout: JSON.stringify({ errors: [error] }),
        stderr: ''
      })
    }
    expect(await fetchAllItems(args)).toMatchObject({ ok: true, parentFieldDropped: true })
    expect(ghExecFileAsync).toHaveBeenCalledTimes(4)
  })

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'RATE_LIMITED', 'NETWORK_ERROR'])(
    'never caches unrelated %s failures',
    async (type) => {
      vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
        stdout: JSON.stringify({ errors: [{ type, message: 'Cannot access subIssuesSummary' }] }),
        stderr: ''
      })
      expect(await fetchAllItems(args)).toMatchObject({ ok: false })
      expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
      expect(await fetchAllItems(args)).toMatchObject({ ok: true, parentFieldDropped: false })
      expect(vi.mocked(ghExecFileAsync).mock.calls[1][0].join(' ')).toContain('subIssuesSummary {')
    }
  )

  it('shares a pending owner capability probe between concurrent callers', async () => {
    let entered = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(ghExecFileAsync).mockImplementationOnce(async () => {
      entered()
      await pending
      return { stdout: JSON.stringify({ errors: [missingSummary] }), stderr: '' }
    })
    const first = fetchAllItems(args)
    await started
    const second = fetchAllItems(args)
    expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
    release()
    const results = await Promise.all([first, second])
    expect(results).toEqual([
      expect.objectContaining({ ok: true, parentFieldDropped: false }),
      expect.objectContaining({ ok: true, parentFieldDropped: false })
    ])
    expect(ghExecFileAsync).toHaveBeenCalledTimes(3)
    expect(vi.mocked(ghExecFileAsync).mock.calls[2][0].join(' ')).not.toContain(
      'subIssuesSummary {'
    )
  })

  it('keeps supported fields and the cursor on pages after a capability retry', async () => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors: [missingSummary] }),
      stderr: ''
    })
    const firstPage = JSON.parse(
      selectedResponse(['parent {', '... on ProjectV2ItemFieldPullRequestValue']).stdout
    )
    firstPage.data.organization.projectV2.items.pageInfo = { hasNextPage: true, endCursor: 'next' }
    firstPage.data.organization.projectV2.items.totalCount = 2
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify(firstPage),
      stderr: ''
    })
    expect(await fetchAllItems(args)).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ position: 0 }), expect.objectContaining({ position: 1 })]
    })
    const last = vi.mocked(ghExecFileAsync).mock.calls[2][0]
    expect(last).toContain('after=next')
    expect(last.join(' ')).not.toContain('subIssuesSummary {')
    expect(last.join(' ')).toContain('parent {')
    expect(last.join(' ')).toContain('... on ProjectV2ItemFieldPullRequestValue')
  })

  it.each([10, 12])('shows exact counts for a linked PR list with total %i', (totalCount) => {
    const row = normalized(item)
    if (!row.content.linkedPullRequests) {
      throw new Error('Expected linked PR content')
    }
    row.content.linkedPullRequests.totalCount = totalCount
    renderColumns(row)
    expect(
      screen.getByText(totalCount === 12 ? prText : prText.replace(' +2', '')).textContent
    ).toBeTruthy()
  })

  it.each([1, 10])('keeps %i returned items in one request', async (count) => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce(
      response(Array.from({ length: count }, (_, i) => ({ ...item, id: `item-${i}` })))
    )
    expect(await fetchAllItems(args)).toMatchObject({
      ok: true,
      rows: Array.from({ length: count }, () =>
        expect.objectContaining({
          content: expect.objectContaining({
            linkedPullRequests: expect.objectContaining({ totalCount: 12 })
          })
        })
      )
    })
    expect(ghExecFileAsync).toHaveBeenCalledTimes(1)
  })
})
