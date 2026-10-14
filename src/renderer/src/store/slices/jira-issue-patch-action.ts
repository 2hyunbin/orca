import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import type { JiraSlice, JiraSliceSet } from './jira-slice-contract'
import type { JiraIssue } from '../../../../shared/jira-types'

export function createJiraIssuePatchAction(set: JiraSliceSet): Pick<JiraSlice, 'patchJiraIssue'> {
  return {
    patchJiraIssue: (issueKey, patch, options) => {
      const sourceScope =
        options?.sourceContext?.provider === 'jira'
          ? getTaskSourceCacheScope(options.sourceContext)
          : null
      const canPatchCacheKey = (key: string): boolean =>
        sourceScope === null || key.startsWith(`${sourceScope}::`)
      const siteId = options?.siteId ?? patch.siteId
      const matchesIssue = (issue: JiraIssue | null | undefined): boolean =>
        issue?.key === issueKey && (siteId == null || issue.siteId === siteId)
      set((state) => {
        let changed = false
        const jiraIssueCache = { ...state.jiraIssueCache }
        for (const [key, entry] of Object.entries(jiraIssueCache)) {
          if (!canPatchCacheKey(key) || !entry?.data || !matchesIssue(entry.data)) {
            continue
          }
          jiraIssueCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
          changed = true
        }
        const jiraSearchCache = { ...state.jiraSearchCache }
        for (const [key, entry] of Object.entries(jiraSearchCache)) {
          if (!canPatchCacheKey(key) || !entry?.data) {
            continue
          }
          const index = entry.data.findIndex(matchesIssue)
          if (index === -1) {
            continue
          }
          const updatedIssues = [...entry.data]
          updatedIssues[index] = { ...updatedIssues[index], ...patch }
          jiraSearchCache[key] = { ...entry, data: updatedIssues }
          changed = true
        }
        return changed ? { jiraIssueCache, jiraSearchCache } : state
      })
    }
  }
}
