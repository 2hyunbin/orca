import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeIdentity } from '../../../shared/worktree/identity'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getIndexedWorktreeByIdentity, getIndexedWorktreesById } from '@/store/worktree-repo-index'
import type { AppState } from '@/store/types'
import { resolveExactWorktreeRoute } from './worktree-owner-route'
import type { WorktreeOperationRouteState } from './worktree-operation-route'
import {
  getRuntimeTargetHostId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/runtime-client-target'
type SelectedWorktreeState = Pick<AppState, 'repos' | 'worktreesByRepo'>

function selectedWorktreeHost(state: WorktreeOperationRouteState, row: Worktree) {
  if (row.hostId) {
    return row.hostId
  }
  const owners = state.repos?.filter((repo) => repo.id === row.repoId) ?? []
  return owners.length === 1 ? getRepoExecutionHostId(owners[0]) : undefined
}

export function selectedWorktreeTransport(state: WorktreeOperationRouteState, row: Worktree) {
  const hostId = selectedWorktreeHost(state, row)
  const route = hostId && resolveExactWorktreeRoute(state, { ...row, hostId })
  return route && route.kind === 'resolved'
    ? runtimeTargetForOwnerEnvironment(route.route.runtimeEnvironmentId)
    : null
}

export type SelectedWorktreeReference = {
  id: string
  hostId: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
  target: RuntimeClientTarget
} & ({ kind: 'identified'; identity: WorktreeIdentity } | { kind: 'legacy' })

export function captureSelectedWorktree(
  state: SelectedWorktreeState,
  row: Worktree
): SelectedWorktreeReference | null {
  const hostId = selectedWorktreeHost(state, row)
  if (!hostId) {
    return null
  }
  const target = selectedWorktreeTransport(state, row)
  if (!target) {
    return null
  }
  const ref: SelectedWorktreeReference = {
    id: row.id,
    hostId,
    runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId,
    target,
    ...(row.identity
      ? ({ kind: 'identified', identity: row.identity } as const)
      : ({ kind: 'legacy' } as const))
  }
  return resolveSelectedWorktree(state, ref) ? ref : null
}

export function resolveSelectedWorktree(
  state: SelectedWorktreeState,
  ref: SelectedWorktreeReference | null | undefined
) {
  if (!ref) {
    return null
  }
  const candidates =
    ref.kind === 'identified'
      ? [
          getIndexedWorktreeByIdentity(state.worktreesByRepo, ref.identity.key, ref.hostId) ??
            getIndexedWorktreeByIdentity(state.worktreesByRepo, ref.identity.key)
        ].filter((row) => row !== undefined)
      : getIndexedWorktreesById(state.worktreesByRepo, ref.id)
  const matches = candidates.filter((row) => {
    const target = selectedWorktreeTransport(state, row)
    return target && getRuntimeTargetHostId(target) === getRuntimeTargetHostId(ref.target)
  })
  const row = matches.length === 1 ? matches[0] : undefined
  if (
    !row ||
    selectedWorktreeHost(state, row) !== ref.hostId ||
    row.runtimeOwnerEnvironmentId !== ref.runtimeOwnerEnvironmentId ||
    (ref.kind === 'identified' && row.identity?.instanceId !== ref.identity.instanceId) ||
    (ref.kind === 'legacy' && row.identity)
  ) {
    return null
  }
  return {
    row,
    target: ref.target,
    selector: ref.kind === 'identified' ? `identity:${ref.identity.key}` : `id:${row.id}`
  }
}
