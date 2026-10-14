import { JIRA_IMAGE_CAPABILITY } from '../../../shared/jira-attachment-image'
import type { JiraComment, JiraIssue } from '../../../shared/jira-types'
import { migrateLegacyJiraImages } from './runtime-jira-image-cache'
import { readRuntimeJiraPayload } from './runtime-jira-payload-stream'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

async function readRemoteJiraPayload<TResult>(
  target: { kind: 'environment'; environmentId: string },
  streamMethod: string,
  fallbackMethod: string,
  args: unknown
): Promise<TResult> {
  try {
    return await readRuntimeJiraPayload<TResult>(target, streamMethod, args)
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    // Older runtimes predate image payload streaming but still return text-only
    // Jira details safely through the original one-shot method.
    return callRuntimeRpc<TResult>(target, fallbackMethod, args, { timeoutMs: 30_000 })
  }
}

export async function jiraGetIssue(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraIssue | null> {
  const target = getJiraRuntimeTarget(settings)
  const references =
    target.kind === 'local' ||
    (await runtimeEnvironmentSupportsCapability(target.environmentId, JIRA_IMAGE_CAPABILITY))
  const args = {
    key,
    siteId: siteId ?? undefined,
    ...(references ? { mediaFormat: 'reference' as const } : {})
  }
  const issue =
    target.kind === 'environment'
      ? references
        ? await callRuntimeRpc<JiraIssue | null>(target, 'jira.getIssue', args, {
            timeoutMs: 30_000
          })
        : await readRemoteJiraPayload<JiraIssue | null>(
            target,
            'jira.getIssueStream',
            'jira.getIssue',
            args
          )
      : await window.api.jira.getIssue(args)
  return issue
    ? { ...issue, description: migrateLegacyJiraImages(issue.description ?? '', target) }
    : null
}

export async function jiraIssueComments(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  const target = getJiraRuntimeTarget(settings)
  const references =
    target.kind === 'local' ||
    (await runtimeEnvironmentSupportsCapability(target.environmentId, JIRA_IMAGE_CAPABILITY))
  const args = {
    key,
    siteId: siteId ?? undefined,
    ...(references ? { mediaFormat: 'reference' as const } : {})
  }
  const comments =
    target.kind === 'environment'
      ? references
        ? await callRuntimeRpc<JiraComment[]>(target, 'jira.issueComments', args, {
            timeoutMs: 30_000
          })
        : await readRemoteJiraPayload<JiraComment[]>(
            target,
            'jira.issueCommentsStream',
            'jira.issueComments',
            args
          )
      : await window.api.jira.issueComments(args)
  return comments.map((comment) => ({
    ...comment,
    body: migrateLegacyJiraImages(comment.body, target)
  }))
}
