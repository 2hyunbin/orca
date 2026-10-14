import type { JiraIssueFilter } from './jira-types'

export function buildJiraPresetJql(filter: JiraIssueFilter): string {
  if (filter === 'assigned') {
    return 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  }
  if (filter === 'reported') {
    return 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  }
  if (filter === 'done') {
    return 'assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC'
  }
  return 'statusCategory != Done ORDER BY updated DESC'
}
