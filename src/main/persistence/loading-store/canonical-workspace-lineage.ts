import type { PersistedState } from '../../../shared/persisted-state-types'
import type { LineageEdge } from '../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  edgeToWorkspaceLineage,
  edgeToWorktreeLineage,
  workspaceLineageToEdge,
  worktreeLineageToEdge
} from '../../../shared/worktree/lineage-edge'

export function savedLineageOwners(
  state: PersistedState
): Map<string, { locator: string; hostId: ExecutionHostId } | null> {
  const owners = new Map<string, { locator: string; hostId: ExecutionHostId } | null>()
  const reposById = new Map<string, typeof state.repos>()
  for (const repo of state.repos ?? []) {
    reposById.set(repo.id, [...(reposById.get(repo.id) ?? []), repo])
  }
  const add = (instance: string | undefined, locator: string, hostId: ExecutionHostId) => {
    if (
      !instance ||
      !reposById
        .get(getRepoIdFromWorktreeId(locator))
        ?.some((repo) => getRepoExecutionHostId(repo) === hostId)
    ) {
      return
    }
    const previous = owners.get(instance)
    if (previous === undefined) {
      owners.set(instance, { locator, hostId })
    } else if (previous && (previous.locator !== locator || previous.hostId !== hostId)) {
      owners.set(instance, null)
    }
  }
  for (const [alias, identities] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    const hostId = getExecutionHostIdFromWorktreeHostIdentity(alias)
    if (!hostId) {
      continue
    }
    for (const identity of identities) {
      const meta = state.worktreeMetaByIdentity?.[identity]
      if (meta?.hostId && meta.hostId !== hostId) {
        continue
      }
      add(meta?.instanceId, getWorktreeIdFromHostIdentity(alias), hostId)
    }
  }
  for (const [id, meta] of Object.entries(state.worktreeMeta ?? {})) {
    if (!meta) {
      continue
    }
    const repos = reposById.get(getRepoIdFromWorktreeId(id)) ?? []
    const owner = meta.hostId ?? (repos.length === 1 ? getRepoExecutionHostId(repos[0]) : undefined)
    if (owner) {
      add(meta.instanceId, id, owner)
    }
  }
  return owners
}

export function refreshLegacyLineage(state: PersistedState): void {
  const worktree: PersistedState['worktreeLineageById'] = {}
  const workspace: PersistedState['workspaceLineageByChildKey'] = {}
  const owners = savedLineageOwners(state)
  for (const edge of Object.values(state.lineageByChildInstance ?? {})) {
    if (!owners.get(edge.child.instanceId)) {
      continue
    }
    const child = parseWorkspaceKey(edge.child.locator)
    if (
      child?.type !== 'worktree' ||
      state.worktreeMeta?.[child.worktreeId]?.instanceId !== edge.child.instanceId
    ) {
      continue
    }
    workspace[edge.child.locator] = edgeToWorkspaceLineage(edge)
    const projected = edgeToWorktreeLineage(edge)
    if (projected) {
      worktree[child.worktreeId] = projected
    }
  }
  state.worktreeLineageById = worktree
  state.workspaceLineageByChildKey = workspace
}

export function ownedLineageEdges(state: PersistedState): LineageEdge[] {
  const owners = savedLineageOwners(state)
  return Object.values(state.lineageByChildInstance ?? {}).flatMap((edge) => {
    const owner = owners.get(edge.child.instanceId)
    return owner
      ? [
          {
            ...edge,
            child: {
              ...edge.child,
              locator: worktreeWorkspaceKey(owner.locator),
              hostId: owner.hostId
            }
          }
        ]
      : []
  })
}

export function initializeCanonicalLineage(state: PersistedState): boolean {
  if (state.lineageByChildInstance !== undefined) {
    refreshLegacyLineage(state)
    return false
  }
  const owners = savedLineageOwners(state)
  const edges: Record<string, LineageEdge> = {}
  const remainder: NonNullable<PersistedState['legacyLineageRemainder']> = {}
  const sources = [
    ...Object.entries(state.worktreeLineageById ?? {}).map(([key, value]) => ({
      key: `worktree:${key}`,
      value,
      edge: value && worktreeLineageToEdge(value)
    })),
    ...Object.entries(state.workspaceLineageByChildKey ?? {}).map(([key, value]) => ({
      key: `workspace:${key}`,
      value,
      edge: value && workspaceLineageToEdge(value)
    }))
  ].sort((a, b) => a.key.localeCompare(b.key))
  const sourceByInstance = new Map<string, (typeof sources)[number]>()
  for (const source of sources) {
    const edge = source.edge
    if (!edge) {
      remainder[source.key] = source.value
      continue
    }
    const owner = owners.get(edge.child.instanceId)
    if (owner) {
      edge.child = {
        ...edge.child,
        locator: worktreeWorkspaceKey(owner.locator),
        hostId: owner.hostId
      }
    }
    const previous = sourceByInstance.get(edge.child.instanceId)
    if (previous) {
      const prior = edges[edge.child.instanceId]
      if (JSON.stringify(prior.parent) !== JSON.stringify(edge.parent)) {
        remainder[previous.key] = previous.value
        remainder[source.key] = source.value
      }
      // Timestamps arbitrate conflicts; workspace records win equal timestamps.
      if (
        prior.createdAt > edge.createdAt ||
        (prior.createdAt === edge.createdAt &&
          previous.key.startsWith('workspace:') &&
          source.key.startsWith('worktree:'))
      ) {
        continue
      }
    }
    edges[edge.child.instanceId] = edge
    sourceByInstance.set(edge.child.instanceId, source)
  }
  state.lineageByChildInstance = edges
  state.legacyLineageRemainder = remainder
  refreshLegacyLineage(state)
  return true
}

export function writeCanonicalLineage(state: PersistedState, edge: LineageEdge): void {
  initializeCanonicalLineage(state)
  const owner = savedLineageOwners(state).get(edge.child.instanceId)
  state.lineageByChildInstance![edge.child.instanceId] = owner
    ? {
        ...edge,
        child: { ...edge.child, locator: worktreeWorkspaceKey(owner.locator), hostId: owner.hostId }
      }
    : edge
  refreshLegacyLineage(state)
}

export function removeCanonicalLineage(
  state: PersistedState,
  instanceId: string | undefined
): void {
  initializeCanonicalLineage(state)
  if (instanceId) {
    delete state.lineageByChildInstance?.[instanceId]
  }
  refreshLegacyLineage(state)
}

export function removeOwnedLineage(
  state: PersistedState,
  id: string,
  hostId?: ExecutionHostId
): void {
  initializeCanonicalLineage(state)
  const owners = savedLineageOwners(state)
  for (const edge of Object.values(state.lineageByChildInstance ?? {})) {
    const owner = owners.get(edge.child.instanceId)
    if (owner?.locator === id && (hostId === undefined || owner.hostId === hostId)) {
      delete state.lineageByChildInstance?.[edge.child.instanceId]
    }
  }
  refreshLegacyLineage(state)
}

export function renameOwnedLineage(
  state: PersistedState,
  id: string,
  nextId: string,
  hostId: ExecutionHostId
): void {
  initializeCanonicalLineage(state)
  const owners = savedLineageOwners(state)
  for (const edge of Object.values(state.lineageByChildInstance ?? {})) {
    const owner = owners.get(edge.child.instanceId)
    if (owner?.locator === id && owner.hostId === hostId) {
      edge.child.locator = worktreeWorkspaceKey(nextId)
    }
  }
}
