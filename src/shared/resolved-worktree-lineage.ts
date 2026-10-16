import type { WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'
import { getWorktreeHostIdentity } from './worktree/host-qualified-identity'

export type WorktreeWithResolvedLineage<T extends Worktree = Worktree> = T & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
}

export function requiresParentWorktreeReference(childHost: string, parentHost: string): boolean {
  const store = (host: string): string => (host.startsWith('runtime:') ? host : 'local')
  return store(childHost) !== store(parentHost)
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
  child: Worktree,
  parent: Worktree,
  lineage: WorktreeLineage
): boolean {
  return (
    getWorktreeHostIdentity(child) !== getWorktreeHostIdentity(parent) &&
    lineage.worktreeId === child.id &&
    Boolean(child.instanceId && parent.instanceId) &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

export function getCyclicChildKeys<Key>(parentByChild: ReadonlyMap<Key, Key>): Set<Key> {
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
        for (let index = cycleStart; index < path.length; index += 1) {
          cyclic.add(path[index])
        }
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

export function getConnectedWorktreeLineageIds(
  seedIds: readonly string[],
  lineageById: Readonly<Record<string, WorktreeLineage>>
): Set<string> {
  const childrenByParentId = new Map<string, string[]>()
  for (const [childId, lineage] of Object.entries(lineageById)) {
    const children = childrenByParentId.get(lineage.parentWorktreeId) ?? []
    children.push(childId)
    childrenByParentId.set(lineage.parentWorktreeId, children)
  }
  const connected = new Set(seedIds)
  const pending = [...connected]
  for (const id of pending) {
    for (const adjacent of [
      lineageById[id]?.parentWorktreeId,
      ...(childrenByParentId.get(id) ?? [])
    ]) {
      if (adjacent && !connected.has(adjacent)) {
        connected.add(adjacent)
        pending.push(adjacent)
      }
    }
  }
  return connected
}

export function projectResolvedWorktreeLineage<T extends Worktree>(
  worktrees: readonly T[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  knownPeers: readonly Worktree[] = []
): WorktreeWithResolvedLineage<T>[] {
  const allWorktrees: readonly Worktree[] = [...worktrees, ...knownPeers]
  const indicesByInstance = new Map<string, number[]>()
  allWorktrees.forEach((worktree, index) => {
    if (!worktree.instanceId) {
      return
    }
    const indices = indicesByInstance.get(worktree.instanceId) ?? []
    indices.push(index)
    indicesByInstance.set(worktree.instanceId, indices)
  })
  const validLineageByChildIndex = new Map<number, WorktreeLineage>()
  const parentIndexByChildIndex = new Map<number, number>()
  const childIdsByParentIndex = new Map<number, string[]>()

  allWorktrees.forEach((child, childIndex) => {
    const lineage = lineageById[getWorktreeHostIdentity(child)] ?? lineageById[child.id]
    if (!lineage) {
      return
    }
    const parentIndices = indicesByInstance.get(lineage.parentWorktreeInstanceId) ?? []
    if (
      parentIndices.length !== 1 ||
      !isValidResolvedWorktreeLineageEdge(child, allWorktrees[parentIndices[0]], lineage)
    ) {
      return
    }
    validLineageByChildIndex.set(childIndex, lineage)
    parentIndexByChildIndex.set(childIndex, parentIndices[0])
  })

  for (const index of getCyclicChildKeys(parentIndexByChildIndex)) {
    validLineageByChildIndex.delete(index)
    parentIndexByChildIndex.delete(index)
  }

  for (const [childIndex, parentIndex] of parentIndexByChildIndex) {
    const children = childIdsByParentIndex.get(parentIndex) ?? []
    children.push(allWorktrees[childIndex].id)
    childIdsByParentIndex.set(parentIndex, children)
  }

  return worktrees.map((worktree, index) => {
    const lineage = validLineageByChildIndex.get(index) ?? null
    return {
      ...worktree,
      parentWorktreeId: allWorktrees[parentIndexByChildIndex.get(index) ?? -1]?.id ?? null,
      childWorktreeIds: childIdsByParentIndex.get(index) ?? [],
      lineage
    }
  })
}
