import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  JiraIssueUpdate,
  JiraMutationResult,
  JiraTransition
} from '../../../shared/jira-types'
import { JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'

export async function jiraUpdateIssueForTarget(
  target: RuntimeClientTarget,
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  if (
    target.kind === 'environment' &&
    (updates.transitionFields || updates.transitionComment !== undefined)
  ) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY,
      'Update the remote Orca server to submit required transition fields, or complete the transition in Jira.'
    )
  }
  const args = { key, updates, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraMutationResult>(target, 'jira.updateIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.updateIssue(args)
}

export async function jiraListTransitionsForTarget(
  target: RuntimeClientTarget,
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const args = { key, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraTransition[]>(target, 'jira.listTransitions', args, { timeoutMs: 30_000 })
    : window.api.jira.listTransitions(args)
}
