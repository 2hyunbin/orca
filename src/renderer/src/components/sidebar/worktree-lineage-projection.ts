import { selectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

type WorktreeWithResolvedLineage = Worktree & { lineage?: WorktreeLineage | null }

export function getProjectedWorktreeLineage(
  worktree: WorktreeWithResolvedLineage,
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeLineage | null | undefined {
  const key = getWorktreeHostIdentity(worktree)
  if (Object.hasOwn(lineageById, key)) {
    return lineageById[key]
  }
  const legacy = lineageById[worktree.id]
  return legacy?.worktreeInstanceId === worktree.instanceId ? legacy : worktree.lineage
}

type LineageProjection = ReturnType<typeof selectResolvedWorktreeLineage<Worktree>> & {
  childrenByParentId?: Map<string, Worktree[]>
}

/**
 * Why: both projections are O(worktrees) scans that the sidebar row builder and
 * the pinned/attached-children readers re-run several times per pass, and
 * zustand re-runs those on every store write. Both are pure in the two inputs,
 * and both inputs are immutable store-derived collections that are REPLACED
 * rather than mutated, so their identity pair is a sound cache key. Weak on both
 * levels so a superseded lineage record or worktree index is not pinned.
 */
const projectionByLineageAndWorktreeMap = new WeakMap<
  Readonly<Record<string, WorktreeLineage>>,
  WeakMap<ReadonlyMap<string, Worktree>, LineageProjection>
>()

function getLineageProjection(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): LineageProjection {
  let byWorktreeMap = projectionByLineageAndWorktreeMap.get(lineageById)
  if (!byWorktreeMap) {
    byWorktreeMap = new WeakMap()
    projectionByLineageAndWorktreeMap.set(lineageById, byWorktreeMap)
  }
  let projection = byWorktreeMap.get(worktreeMap)
  if (!projection) {
    projection = selectResolvedWorktreeLineage([...worktreeMap.values()], (child) =>
      getProjectedWorktreeLineage(child, lineageById)
    )
    byWorktreeMap.set(worktreeMap, projection)
  }
  return projection
}

export function getCyclicProjectedWorktreeLineageIds(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Set<string> {
  return getLineageProjection(lineageById, worktreeMap).suppressed
}

export function getLineageRenderInfo(
  worktree: WorktreeWithResolvedLineage,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): LineageRenderInfo {
  const lineage = getProjectedWorktreeLineage(worktree, lineageById)
  if (!lineage) {
    return { state: 'none' }
  }
  const edge = getLineageProjection(lineageById, worktreeMap).selected.get(
    getWorktreeHostIdentity(worktree)
  )
  if (cyclicLineageIds.has(getWorktreeHostIdentity(worktree)) || !edge) {
    return { state: 'missing', lineage }
  }
  return { state: 'valid', lineage, parent: edge.parent }
}

export function getProjectedWorktreeLineageChildrenByParentId(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Map<string, Worktree[]> {
  const projection = getLineageProjection(lineageById, worktreeMap)
  if (projection.childrenByParentId) {
    return projection.childrenByParentId
  }
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const childrenByParentId = new Map<string, Worktree[]>()
  for (const worktree of worktreeMap.values()) {
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeMap, cyclicLineageIds)
    if (lineage.state !== 'valid') {
      continue
    }
    const children = childrenByParentId.get(getWorktreeHostIdentity(lineage.parent)) ?? []
    children.push(worktree)
    childrenByParentId.set(getWorktreeHostIdentity(lineage.parent), children)
  }
  projection.childrenByParentId = childrenByParentId
  return childrenByParentId
}

/** Keep every visible host so instance links can resolve across machines. */
export function getHostScopedWorktreeLineageInputs(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  _executionHostId: ExecutionHostId | undefined
): { worktreeMap: Map<string, Worktree>; lineageById: Record<string, WorktreeLineage> } {
  const worktreeMap = new Map<string, Worktree>()
  const hostLineageById: Record<string, WorktreeLineage> = {}
  for (const worktree of worktrees) {
    const key = getWorktreeHostIdentity(worktree)
    worktreeMap.set(key, worktree)
    const projected = lineageById[key]
    const lineage = projected ?? getProjectedWorktreeLineage(worktree, lineageById)
    if (lineage) {
      hostLineageById[key] = lineage
    }
  }
  return { worktreeMap, lineageById: hostLineageById }
}

export function getWorktreeLineageAncestors(
  worktree: WorktreeWithResolvedLineage,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] {
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const ancestors: Worktree[] = []
  const seen = new Set<string>()
  let current: Worktree | undefined = worktree
  while (current && !seen.has(getWorktreeHostIdentity(current))) {
    seen.add(getWorktreeHostIdentity(current))
    const lineage = getLineageRenderInfo(current, lineageById, worktreeMap, cyclicLineageIds)
    if (lineage.state !== 'valid') {
      break
    }
    ancestors.push(lineage.parent)
    current = lineage.parent
  }
  return ancestors
}

/** Resolve the parent by its immutable instance, including after a rename on another machine. */
export function getSidebarLineageParent(
  worktree: WorktreeWithResolvedLineage,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>
): Worktree | undefined {
  return getLineageProjection(lineageById, rowsByHostIdentity).selected.get(
    getWorktreeHostIdentity(worktree)
  )?.parent
}

/** The rows a worktree nests under in the sidebar, nearest first; a lineage cycle nests nothing. */
export function getSidebarLineageAncestors(
  worktree: WorktreeWithResolvedLineage,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): Worktree[] {
  const ancestors: Worktree[] = []
  const seen = new Set([getWorktreeHostIdentity(worktree)])
  let current = worktree
  while (!cyclicLineageIds.has(getWorktreeHostIdentity(current))) {
    const parent = getSidebarLineageParent(current, lineageById, rowsByHostIdentity)
    if (!parent || seen.has(getWorktreeHostIdentity(parent))) {
      break
    }
    seen.add(getWorktreeHostIdentity(parent))
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}
