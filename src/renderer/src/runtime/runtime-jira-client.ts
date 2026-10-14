import type {
  JiraAuthType,
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSiteSelection,
  JiraTransition,
  JiraViewer
} from '../../../shared/jira-types'
import { searchLocalJiraIssues } from './local-jira-search-cancellation'
import { callRuntimeRpc } from './runtime-rpc-client'
import { clearJiraImageCache } from './runtime-jira-image-cache'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'
import { parseJiraConnectionStatus } from './runtime-jira-connection-status'

export { jiraLookupIssueSummary, jiraReadStatus } from './runtime-jira-summary-client'
import { jiraGetIssueForTarget, jiraIssueCommentsForTarget } from './runtime-jira-detail-client'
export { jiraGetIssueForTarget, jiraIssueCommentsForTarget } from './runtime-jira-detail-client'
export {
  jiraCreateIssue,
  jiraListAssignableUsers,
  jiraListAssignableUsersForProject,
  jiraSearchUsers
} from './runtime-jira-user-fields-client'
export type { RuntimeJiraSettings } from './runtime-jira-target'

export type JiraConnectResult = { ok: true; viewer: JiraViewer } | { ok: false; error: string }
export type JiraCommentResult = { ok: true; id: string } | { ok: false; error: string }

export async function jiraGetIssue(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraIssue | null> {
  return jiraGetIssueForTarget(getJiraRuntimeTarget(settings), key, siteId)
}

export async function jiraIssueComments(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  return jiraIssueCommentsForTarget(getJiraRuntimeTarget(settings), key, siteId)
}

export async function jiraStatus(settings: RuntimeJiraSettings): Promise<JiraConnectionStatus> {
  const target = getJiraRuntimeTarget(settings)
  return parseJiraConnectionStatus(
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(target, 'jira.status', undefined, { timeoutMs: 15_000 })
      : await window.api.jira.status()
  )
}

export async function jiraConnect(
  settings: RuntimeJiraSettings,
  args: { siteUrl: string; email: string; apiToken: string; authType?: JiraAuthType }
): Promise<JiraConnectResult> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectResult>(target, 'jira.connect', args, { timeoutMs: 30_000 })
    : window.api.jira.connect(args)
}

export async function jiraDisconnect(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<void> {
  clearJiraImageCache()
  const target = getJiraRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(target, 'jira.disconnect', siteId ? { siteId } : undefined, {
      timeoutMs: 15_000
    })
    return
  }
  await window.api.jira.disconnect(siteId ? { siteId } : undefined)
}

export async function jiraSelectSite(
  settings: RuntimeJiraSettings,
  siteId: JiraSiteSelection
): Promise<JiraConnectionStatus> {
  const target = getJiraRuntimeTarget(settings)
  return parseJiraConnectionStatus(
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(target, 'jira.selectSite', { siteId }, { timeoutMs: 15_000 })
      : await window.api.jira.selectSite({ siteId })
  )
}

export async function jiraTestConnection(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<JiraConnectResult> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectResult>(
        target,
        'jira.testConnection',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.testConnection(siteId ? { siteId } : undefined)
}

export async function jiraSearchIssues(
  settings: RuntimeJiraSettings,
  jql: string,
  limit?: number,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal
): Promise<JiraIssue[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(jql)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  const args = { jql, limit, siteId: siteId ?? undefined }
  if (target.kind === 'environment') {
    return callRuntimeRpc<JiraIssue[]>(target, 'jira.searchIssues', args, {
      timeoutMs: 30_000,
      signal
    })
  }
  return signal ? searchLocalJiraIssues(args, signal) : window.api.jira.searchIssues(args)
}

export async function jiraListIssues(
  settings: RuntimeJiraSettings,
  filter?: JiraIssueFilter,
  limit?: number,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { filter, limit, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssue[]>(target, 'jira.listIssues', args, { timeoutMs: 30_000 })
    : window.api.jira.listIssues(args)
}

export async function jiraUpdateIssue(
  settings: RuntimeJiraSettings,
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, updates, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraMutationResult>(target, 'jira.updateIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.updateIssue(args)
}

export async function jiraAddIssueComment(
  settings: RuntimeJiraSettings,
  key: string,
  body: string,
  siteId?: string | null
): Promise<JiraCommentResult> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, body, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCommentResult>(target, 'jira.addIssueComment', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.addIssueComment(args)
}

export async function jiraListProjects(
  settings: RuntimeJiraSettings,
  siteId?: JiraSiteSelection | null
): Promise<JiraProject[]> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraProject[]>(target, 'jira.listProjects', siteId ? { siteId } : undefined, {
        timeoutMs: 30_000
      })
    : window.api.jira.listProjects(siteId ? { siteId } : undefined)
}

export async function jiraListIssueTypes(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { projectIdOrKey, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssueType[]>(target, 'jira.listIssueTypes', args, { timeoutMs: 30_000 })
    : window.api.jira.listIssueTypes(args)
}

export async function jiraListCreateFields(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string | null
): Promise<JiraCreateField[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { projectIdOrKey, issueTypeId, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCreateField[]>(target, 'jira.listCreateFields', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.listCreateFields(args)
}

export async function jiraListPriorities(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<JiraPriority[]> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraPriority[]>(
        target,
        'jira.listPriorities',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.listPriorities(siteId ? { siteId } : undefined)
}

/** Lists users assignable to an existing issue, via the active runtime. */
export async function jiraListTransitions(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraTransition[]>(target, 'jira.listTransitions', args, { timeoutMs: 30_000 })
    : window.api.jira.listTransitions(args)
}

export async function jiraGetProjectStatusOrder(
  settings: RuntimeJiraSettings,
  projectKey: string,
  siteId?: string | null
): Promise<JiraProjectStatusOrder> {
  const target = getJiraRuntimeTarget(settings)
  const args = { projectKey, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraProjectStatusOrder>(target, 'jira.getProjectStatusOrder', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.getProjectStatusOrder(args)
}
