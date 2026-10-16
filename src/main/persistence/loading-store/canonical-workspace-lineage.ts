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

export function savedLineageOwners(state: PersistedState) {
  const owners = new Map<string, { locator: string; hostId: ExecutionHostId } | null>()
  const byLocator = new Map<string, Set<string>>()
  const reposById = new Map<string, typeof state.repos>()
  const repoOwnerCounts = new Map<string, number>()
  for (const repo of state.repos ?? []) {
    const bucket = reposById.get(repo.id)
    if (bucket) {
      bucket.push(repo)
    } else {
      reposById.set(repo.id, [repo])
    }
    const key = JSON.stringify([repo.id, getRepoExecutionHostId(repo)])
    repoOwnerCounts.set(key, (repoOwnerCounts.get(key) ?? 0) + 1)
  }
  const add = (instance: string | undefined, locator: string, hostId: ExecutionHostId) => {
    if (
      !instance ||
      repoOwnerCounts.get(JSON.stringify([getRepoIdFromWorktreeId(locator), hostId])) !== 1
    ) {
      return
    }
    const candidates = byLocator.get(locator) ?? new Set<string>()
    candidates.add(instance)
    byLocator.set(locator, candidates)
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
  return Object.assign(owners, { byLocator })
}

export function refreshLegacyLineage(
  state: PersistedState,
  owners?: ReturnType<typeof savedLineageOwners>
): void {
  const worktree: PersistedState['worktreeLineageById'] = {}
  const workspace: PersistedState['workspaceLineageByChildKey'] = {}
  const edges = Object.values(state.lineageByChildInstance ?? {})
  if (edges.length && !owners) {
    owners = savedLineageOwners(state)
  }
  for (const edge of edges.length ? ownedLineageEdges(state, owners) : []) {
    const child = parseWorkspaceKey(edge.child.locator)
    const folder = parseWorkspaceKey(edge.parent.locator)
    if (
      edge.parent.instanceId
        ? !owners?.get(edge.parent.instanceId)
        : folder?.type !== 'folder' ||
          !state.folderWorkspaces?.some((row) => row.id === folder.folderWorkspaceId)
    ) {
      continue
    }
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

export function ownedLineageEdges(
  state: PersistedState,
  owners = savedLineageOwners(state)
): LineageEdge[] {
  return Object.values(state.lineageByChildInstance ?? {}).flatMap(
    (edge) => projectOwnedLineageEdge(state, edge, owners) ?? []
  )
}

export function projectOwnedLineageEdge(
  state: PersistedState,
  edge: LineageEdge,
  owners = savedLineageOwners(state)
): LineageEdge | undefined {
  const child = owners.get(edge.child.instanceId)
  const parent = edge.parent.instanceId ? owners.get(edge.parent.instanceId) : undefined
  if (!child) {
    return undefined
  }
  return {
    ...edge,
    child: { ...edge.child, locator: worktreeWorkspaceKey(child.locator), hostId: child.hostId },
    parent: parent ? { ...edge.parent, locator: worktreeWorkspaceKey(parent.locator) } : edge.parent
  }
}

export function initializeCanonicalLineage(
  state: PersistedState,
  owners = savedLineageOwners(state)
): boolean {
  if (state.lineageByChildInstance !== undefined) {
    refreshLegacyLineage(state, owners)
    return false
  }
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
    let edge = source.edge
    const value = source.value
    if (!edge && value && 'childWorkspaceKey' in value && !value.childInstanceId) {
      const child = parseWorkspaceKey(value.childWorkspaceKey)
      const parent = parseWorkspaceKey(value.parentWorkspaceKey)
      const matches =
        child?.type === 'worktree' ? [...(owners.byLocator.get(child.worktreeId) ?? [])] : []
      if (
        matches.length === 1 &&
        owners.get(matches[0]) &&
        parent?.type === 'folder' &&
        state.folderWorkspaces?.some((row) => row.id === parent.folderWorkspaceId)
      ) {
        edge = workspaceLineageToEdge({ ...value, childInstanceId: matches[0] })
      }
    }
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
      if (
        prior.parent.instanceId !== edge.parent.instanceId ||
        prior.parent.locator !== edge.parent.locator
      ) {
        remainder[previous.key] = previous.value
        remainder[source.key] = source.value
      }
      // Explicit instances outrank inferred attachments; timestamps arbitrate equivalent sources.
      if (
        (previous.edge && !source.edge) ||
        (Boolean(previous.edge) === Boolean(source.edge) &&
          (prior.createdAt > edge.createdAt ||
            (prior.createdAt === edge.createdAt &&
              previous.key.startsWith('workspace:') &&
              source.key.startsWith('worktree:'))))
      ) {
        continue
      }
    }
    edges[edge.child.instanceId] = edge
    sourceByInstance.set(edge.child.instanceId, source)
  }
  state.lineageByChildInstance = edges
  state.legacyLineageRemainder = remainder
  refreshLegacyLineage(state, owners)
  return true
}

export function writeCanonicalLineage(state: PersistedState, edge: LineageEdge): void {
  const owners = savedLineageOwners(state)
  if (state.lineageByChildInstance === undefined) {
    initializeCanonicalLineage(state, owners)
  }
  state.lineageByChildInstance![edge.child.instanceId] = edge
  refreshLegacyLineage(state, owners)
}

export function removeCanonicalLineage(
  state: PersistedState,
  instanceId: string | undefined
): void {
  const owners = savedLineageOwners(state)
  if (state.lineageByChildInstance === undefined) {
    initializeCanonicalLineage(state, owners)
  }
  if (instanceId) {
    delete state.lineageByChildInstance?.[instanceId]
  }
  refreshLegacyLineage(state, owners)
}

export function removeOwnedLineage(
  state: PersistedState,
  id: string,
  hostId?: ExecutionHostId
): void {
  const owners = savedLineageOwners(state)
  if (state.lineageByChildInstance === undefined) {
    initializeCanonicalLineage(state, owners)
  }
  for (const edge of Object.values(state.lineageByChildInstance ?? {})) {
    const owner = owners.get(edge.child.instanceId)
    if (owner?.locator === id && (hostId === undefined || owner.hostId === hostId)) {
      delete state.lineageByChildInstance?.[edge.child.instanceId]
    }
  }
  refreshLegacyLineage(state, owners)
}
