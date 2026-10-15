import { describe, expect, it } from 'vitest'
import { hasLinkedJiraIssue } from './worktree-linked-jira-issue'

describe('hasLinkedJiraIssue', () => {
  it('finds a linked Jira issue and ignores everything else', () => {
    expect(hasLinkedJiraIssue([{ provider: 'jira', type: 'issue', number: 1 }])).toBe(true)
    expect(hasLinkedJiraIssue([{ provider: 'linear', type: 'issue', number: 1 }])).toBe(false)
    expect(hasLinkedJiraIssue([{ provider: 'jira', type: 'pr', number: 1 }])).toBe(false)
    // Older hosts omit the list; a malformed one must not throw.
    expect(hasLinkedJiraIssue(undefined)).toBe(false)
    expect(hasLinkedJiraIssue('jira')).toBe(false)
    expect(hasLinkedJiraIssue([null, 3])).toBe(false)
  })
})
