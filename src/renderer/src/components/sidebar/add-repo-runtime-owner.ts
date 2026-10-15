import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type CapturedRuntimeOwner = string | null | undefined

export function capturedAddRepoExecutionHostId(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): ExecutionHostId | undefined {
  return sshConnectionId
    ? toSshExecutionHostId(sshConnectionId)
    : owner !== undefined
      ? owner
        ? toRuntimeExecutionHostId(owner)
        : LOCAL_EXECUTION_HOST_ID
      : undefined
}

export function worktreeRefreshOptions(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): {
  requireAuthoritative: true
  executionHostId?: ExecutionHostId
} {
  const executionHostId = capturedAddRepoExecutionHostId(owner, sshConnectionId)
  return {
    requireAuthoritative: true,
    ...(executionHostId ? { executionHostId } : {})
  }
}

/** Refreshes after an add follow the returned row's owner, which need not be the picked host. */
export function addedRepoRefreshOptions(repo: {
  executionHostId?: string | null
  connectionId?: string | null
}): { requireAuthoritative: true; executionHostId: ExecutionHostId } {
  return { requireAuthoritative: true, executionHostId: getRepoExecutionHostId(repo) }
}

/** The host the Add Project dialog picked; no picked server means this app. */
export function resolveAddRepoRuntimeTarget(
  runtimeEnvironmentId: string | null | undefined
): RuntimeClientTarget {
  return runtimeTargetForOwnerEnvironment(runtimeEnvironmentId ?? null)
}
