import type { JiraPriority } from '../../../shared/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

export async function jiraListPrioritiesForTarget(
  target: RuntimeClientTarget,
  siteId?: string | null
): Promise<JiraPriority[]> {
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraPriority[]>(
        target,
        'jira.listPriorities',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.listPriorities(siteId ? { siteId } : undefined)
}
