import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { planStartupLayoutRewrite } from '../../../shared/workspace-layout/workspace-layout-startup-rewrite'
import { isFrozenOrcadSourceSessionPartition } from '../../ssh/orcad-retained-source'

export type StartupLayoutRewriteSummary = {
  rewritten: ExecutionHostId[]
  skipped: { hostId: ExecutionHostId; reason: string }[]
}

/**
 * Replaces each stored layout partition with the shared Loader's round trip where that is proven
 * not to change what the window shows; returns what changed so the caller can save once.
 */
export function rewriteStoredLayoutsAtStartup(state: PersistedState): StartupLayoutRewriteSummary {
  const summary: StartupLayoutRewriteSummary = { rewritten: [], skipped: [] }
  const rewrite = (hostId: ExecutionHostId, session: WorkspaceSessionState) => {
    const plan = planStartupLayoutRewrite(hostId, session)
    if (plan.kind === 'skipped') {
      summary.skipped.push({ hostId, reason: plan.reason })
    } else if (plan.kind === 'rewrite') {
      summary.rewritten.push(hostId)
      return plan.session
    }
    return undefined
  }
  const local = rewrite(LOCAL_EXECUTION_HOST_ID, state.workspaceSession)
  if (local) {
    state.workspaceSession = local
  }
  // A fenced host's partition is migration source; changing it marks the move as stale.
  const store = {
    getSshTarget: (id: string) => state.sshTargets.find((target) => target.id === id)
  }
  for (const [key, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    const hostId = normalizeExecutionHostId(key)
    if (!session || !hostId || isFrozenOrcadSourceSessionPartition(store, hostId)) {
      continue
    }
    const next = rewrite(hostId, session)
    if (next) {
      state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [key]: next }
    }
  }
  return summary
}
