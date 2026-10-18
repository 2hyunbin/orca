import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Worktree } from '../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../shared/workspace-session-host-field-ownership'
import {
  contestedPartitionHosts,
  pickPrimaryHostForClaims
} from '../../shared/workspace-session-contested-primary-host'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimeStore } from './runtime-store-contract'

export type CachedWorktreeHost = Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>

type TwinRepoStore = Pick<RuntimeStore, 'getRepos' | 'getWorkspaceSession'>

const WORKTREE_KEYED_FIELDS = new Set(
  Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)
    .filter(([, ownership]) => ownership === 'worktreeKeyed')
    .map(([field]) => field)
)

function partitionHoldsWorktree(
  session: WorkspaceSessionState | undefined,
  worktreeId: string
): boolean {
  const workspaceKey = worktreeWorkspaceKey(worktreeId)
  return Object.entries(session ?? {}).some(
    ([field, record]: [string, unknown]) =>
      WORKTREE_KEYED_FIELDS.has(field) &&
      typeof record === 'object' &&
      record !== null &&
      (Object.hasOwn(record, worktreeId) || Object.hasOwn(record, workspaceKey))
  )
}

function cachedWorktreeHostId(worktree: CachedWorktreeHost): ExecutionHostId | null {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  return runtimeOwner
    ? toRuntimeExecutionHostId(runtimeOwner)
    : (parseExecutionHostId(worktree.hostId)?.id ?? null)
}

/**
 * The session host of a worktree whose repo id is registered on several hosts, chosen the way the
 * window saves it; null when the repo is on one host. Hosts that hold the worktree come first from
 * the partitions its rows were read from (the window honours those before its catalog), then from
 * the cached worktree list; one holder routes to itself, several to the shared primary. With
 * neither known, the primary of all the repo's hosts stands in for the window's catalog.
 */
export function resolveTwinRepoSessionHostId(
  store: TwinRepoStore,
  repoId: string,
  worktreeId: string,
  cachedWorktrees: readonly CachedWorktreeHost[] | null
): ExecutionHostId | null {
  const twins = contestedPartitionHosts(
    (store.getRepos?.() ?? [])
      .filter((repo) => repo.id === repoId)
      .map((repo) => getRepoExecutionHostId(repo))
  )
  if (twins.length < 2) {
    return null
  }
  const saved = twins.filter((hostId) =>
    partitionHoldsWorktree(store.getWorkspaceSession?.(hostId), worktreeId)
  )
  if (saved.length > 0) {
    return pickPrimaryHostForClaims(saved)
  }
  const listed = new Set(
    (cachedWorktrees ?? [])
      .filter((worktree) => worktree.id === worktreeId)
      .map(cachedWorktreeHostId)
      .filter((hostId): hostId is ExecutionHostId => hostId !== null && twins.includes(hostId))
  )
  return pickPrimaryHostForClaims(listed.size > 0 ? listed : twins)
}
