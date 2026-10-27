import { describe, expect, it } from 'vitest'
import { normalizeFieldValue } from './project-view/project-view-field-normalization'
describe('normalizeFieldValue linked PR values', () => {
  it('normalizes linked pull requests with a visible overflow count', () => {
    const value = normalizeFieldValue({
      __typename: 'ProjectV2ItemFieldPullRequestValue',
      field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
      pullRequests: {
        totalCount: 12,
        nodes: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }, null]
      }
    })
    expect(value).toEqual({
      kind: 'pull-requests',
      fieldId: 'field-pr',
      pullRequests: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }],
      totalCount: 12
    })
  })
})
