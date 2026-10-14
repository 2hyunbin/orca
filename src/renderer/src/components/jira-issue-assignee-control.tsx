import { useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { JiraUserPicker } from '@/components/jira-user-picker'
import { getJiraSelfUser } from '@/components/jira-self-user'
import { useJiraSourceConnection } from '@/components/new-workspace/use-jira-source-connection'
import { useAppStore } from '@/store'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { compareBaseSensitivityLocaleText } from '@/lib/locale-text-collators'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { jiraListAssignableUsers } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { JiraIssue, JiraIssueUpdate, JiraUser } from '../../../shared/jira-types'

export function JiraIssueAssigneeControl({
  issue,
  disabled,
  sourceContext,
  mutateIssue
}: {
  issue: JiraIssue
  disabled: boolean
  sourceContext?: TaskSourceContext | null
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<unknown>
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const defaultStatus = useAppStore((state) => state.jiraStatus)
  const defaultStatusKey = useAppStore((state) => state.jiraStatusContextKey)
  const connection = useJiraSourceConnection({
    enabled: true,
    sourceContext: sourceContext ?? null
  })
  const providerSettings = useMemo(
    () => sourceContext ?? defaultScopeSource(settings),
    [settings, sourceContext]
  )
  const status = sourceContext
    ? connection.status
    : defaultStatusKey === getProviderRuntimeContextKey(settings)
      ? defaultStatus
      : null
  const self = getJiraSelfUser(status, issue.siteId)
  const selfAccountId = self?.accountId
  const searchUsers = useCallback(
    async (query: string) => {
      const found = await jiraListAssignableUsers(providerSettings, issue.key, query, issue.siteId)
      return [...found].sort((a, b) => {
        if ((a.accountId === selfAccountId) !== (b.accountId === selfAccountId)) {
          return a.accountId === selfAccountId ? -1 : 1
        }
        return (
          compareBaseSensitivityLocaleText(a.displayName, b.displayName) ||
          a.accountId.localeCompare(b.accountId)
        )
      })
    },
    [issue.key, issue.siteId, providerSettings, selfAccountId]
  )
  const assign = (user: JiraUser | null): void => {
    if (disabled) {
      return
    }
    void mutateIssue(
      'assignee',
      { assigneeAccountId: user?.accountId ?? null },
      { assignee: user ?? undefined }
    )
  }
  const sourceKey = sourceContext
    ? getTaskSourceCacheScope(sourceContext)
    : getProviderRuntimeContextKey(settings)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="w-40">
        <JiraUserPicker
          key={JSON.stringify([sourceKey, issue.siteId, issue.key])}
          providerSettings={providerSettings}
          siteId={issue.siteId}
          value={
            issue.assignee?.accountId ??
            translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')
          }
          selectedUser={issue.assignee ?? null}
          onSelect={assign}
          disabled={disabled}
          label={translate('components.jiraIssueAssigneeField.label', 'Assignee')}
          fixedOptions={[
            {
              key: 'unassigned',
              label: translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned'),
              onSelect: () => assign(null)
            }
          ]}
          searchUsers={searchUsers}
        />
      </div>
      {self && issue.assignee?.accountId !== self.accountId ? (
        <Button variant="ghost" size="xs" disabled={disabled} onClick={() => assign(self)}>
          {translate('components.jiraIssueAssigneeField.assignToMe', 'Assign to me ({{name}})', {
            name: self.displayName
          })}
        </Button>
      ) : null}
    </div>
  )
}
