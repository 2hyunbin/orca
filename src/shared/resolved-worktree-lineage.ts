import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'
import { getWorktreeHostIdentity } from './worktree/host-qualified-identity'

export type WorktreeWithResolvedLineage<T extends Worktree = Worktree> = T & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
}

export function indexWorktreesByInstance<T extends { instanceId?: string }>(
  worktrees: Iterable<T>
): Map<string, T | null> {
  const byInstance = new Map<string, T | null>()
  for (const worktree of worktrees) {
    if (worktree.instanceId) {
      byInstance.set(worktree.instanceId, byInstance.has(worktree.instanceId) ? null : worktree)
    }
  }
  return byInstance
}

export function isValidResolvedWorktreeLineageEdge(
  child: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>,
  parent: Pick<Worktree, 'id' | 'hostId' | 'instanceId'>,
  lineage: WorktreeLineage
): boolean {
  return (
    getWorktreeHostIdentity(child) !== getWorktreeHostIdentity(parent) &&
    Boolean(child.instanceId && parent.instanceId) &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

export function getCyclicChildKeys<Key>(
  parentByChild: ReadonlyMap<Key, Key>,
  rank: (key: Key) => { createdAt: number; instanceId: string }
): Set<Key> {
  const processed = new Set<Key>()
  const cyclic = new Set<Key>()

  for (const childId of parentByChild.keys()) {
    if (processed.has(childId)) {
      continue
    }
    const path: Key[] = []
    const pathIndexById = new Map<Key, number>()
    let currentId: Key | undefined = childId
    while (currentId !== undefined && parentByChild.has(currentId) && !processed.has(currentId)) {
      const cycleStart = pathIndexById.get(currentId)
      if (cycleStart !== undefined) {
        const newest = path.slice(cycleStart).reduce((winner, key) => {
          const candidate = rank(key)
          const best = rank(winner)
          return candidate.createdAt > best.createdAt ||
            (candidate.createdAt === best.createdAt && candidate.instanceId < best.instanceId)
            ? key
            : winner
        })
        cyclic.add(newest)
        break
      }
      pathIndexById.set(currentId, path.length)
      path.push(currentId)
      currentId = parentByChild.get(currentId)
    }
    for (const id of path) {
      processed.add(id)
    }
  }

  return cyclic
}

export function getConnectedWorktreeLineageInstances(
  seedInstances: readonly string[],
  lineageById: Readonly<Record<string, WorktreeLineage>>
): Set<string> {
  const edges = Object.values(lineageById)
  const adjacency = new Map<string, Set<string>>()
  const connectedInstances = new Set(seedInstances)
  for (const edge of edges) {
    for (const [from, to] of [
      [edge.worktreeInstanceId, edge.parentWorktreeInstanceId],
      [edge.parentWorktreeInstanceId, edge.worktreeInstanceId]
    ]) {
      const adjacent = adjacency.get(from) ?? new Set<string>()
      adjacent.add(to)
      adjacency.set(from, adjacent)
    }
  }

  const pending = [...connectedInstances]
  for (const instance of pending) {
    for (const adjacent of adjacency.get(instance) ?? []) {
      if (!connectedInstances.has(adjacent)) {
        connectedInstances.add(adjacent)
        pending.push(adjacent)
      }
    }
  }
  return connectedInstances
}

export function selectResolvedWorktreeLineage<
  T extends Pick<Worktree, 'id' | 'hostId' | 'instanceId'>
>(worktrees: readonly T[], getLineage: (child: T) => WorktreeLineage | null | undefined) {
  const byInstance = indexWorktreesByInstance(worktrees)
  const selected = new Map<string, { lineage: WorktreeLineage; parent: T }>()
  const parents = new Map<string, string>()
  for (const child of worktrees) {
    const lineage = getLineage(child)
    const parent = lineage && byInstance.get(lineage.parentWorktreeInstanceId)
    if (
      !lineage ||
      !parent ||
      !byInstance.get(lineage.worktreeInstanceId) ||
      !isValidResolvedWorktreeLineageEdge(child, parent, lineage)
    ) {
      continue
    }
    const key = getWorktreeHostIdentity(child)
    selected.set(key, { lineage, parent })
    parents.set(key, getWorktreeHostIdentity(parent))
  }
  const suppressed = getCyclicChildKeys(parents, (key) => ({
    createdAt: selected.get(key)?.lineage.createdAt ?? 0,
    instanceId: selected.get(key)?.lineage.worktreeInstanceId ?? ''
  }))
  for (const key of suppressed) {
    selected.delete(key)
  }
  return { selected, suppressed }
}

export function projectResolvedWorktreeLineage<T extends Worktree>(
  worktrees: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  knownPeers: readonly Worktree[] = []
): WorktreeWithResolvedLineage<T>[] {
  const all = [...worktrees, ...knownPeers]
  const { selected } = selectResolvedWorktreeLineage(
    all,
    (child) => lineageById[getWorktreeHostIdentity(child)] ?? lineageById[child.id]
  )
  const children = new Map<string, string[]>()
  for (const child of all) {
    const edge = selected.get(getWorktreeHostIdentity(child))
    if (!edge) {
      continue
    }
    const key = getWorktreeHostIdentity(edge.parent)
    children.set(key, [...(children.get(key) ?? []), child.id])
  }
  return worktrees.map((worktree) => {
    const key = getWorktreeHostIdentity(worktree)
    const edge = selected.get(key)
    return {
      ...worktree,
      parentWorktreeId: edge?.parent.id ?? null,
      childWorktreeIds: children.get(key) ?? [],
      lineage: edge?.lineage ?? null
    }
  })
}
