import { resolveWorktreeLineageParents } from '../resolved-worktree-lineage'
import type { ExecutionHostId } from '../execution-host'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

export function getProjectedWorktreeLineage(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeLineage | null | undefined {
  const saved = lineageById[worktree.id]
  if (saved?.worktreeId === worktree.id && saved.worktreeInstanceId === worktree.instanceId) {
    return saved
  }
  return worktree.savedLineage ?? worktree.lineage
}

type LineageProjection = {
  cyclicLineageIds?: Set<string>
  childrenByParentId?: Map<string, Worktree[]>
  sidebarParentByIdentity?: Map<string, Worktree>
  parents?: Map<Worktree, Worktree>
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
    projection = {}
    byWorktreeMap.set(worktreeMap, projection)
  }
  return projection
}

export function getCyclicProjectedWorktreeLineageIds(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Set<string> {
  const projection = getLineageProjection(lineageById, worktreeMap)
  if (projection.cyclicLineageIds) {
    return projection.cyclicLineageIds
  }
  // The shared resolver removes cycle edges before any consumer walks the projection.
  resolvedParents(lineageById, worktreeMap)
  const cyclicLineageIds = projection.cyclicLineageIds ?? new Set<string>()
  return cyclicLineageIds
}

export function getLineageRenderInfo(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): LineageRenderInfo {
  const lineage = getProjectedWorktreeLineage(worktree, lineageById)
  if (!lineage) {
    return { state: 'none' }
  }
  const parent = resolvedParents(lineageById, worktreeMap).get(worktree)
  if (cyclicLineageIds.has(worktree.id) || !parent) {
    return { state: 'missing', lineage }
  }
  return { state: 'valid', lineage, parent }
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
    const children = childrenByParentId.get(lineage.parent.id) ?? []
    children.push(worktree)
    childrenByParentId.set(lineage.parent.id, children)
  }
  projection.childrenByParentId = childrenByParentId
  return childrenByParentId
}

/**
 * Lineage inputs for one execution host. Why: the id-keyed projection keeps one
 * row per id, so a two-host id collision must be narrowed to the target's host.
 */
export function getHostScopedWorktreeLineageInputs(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  executionHostId: ExecutionHostId | undefined
): { worktreeMap: Map<string, Worktree>; lineageById: Record<string, WorktreeLineage> } {
  const worktreeMap = new Map<string, Worktree>()
  const hostLineageById: Record<string, WorktreeLineage> = {}
  for (const worktree of worktrees) {
    const existing = worktreeMap.get(worktree.id)
    if (existing && existing.hostId === executionHostId) {
      continue
    }
    worktreeMap.set(worktree.id, worktree)
    const projected = lineageById[worktree.id]
    const inline = worktree.savedLineage ?? worktree.lineage
    const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
    if (lineage) {
      hostLineageById[worktree.id] = lineage
    }
  }
  return { worktreeMap, lineageById: hostLineageById }
}

export function getWorktreeLineageAncestors(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] {
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const ancestors: Worktree[] = []
  const seen = new Set<string>()
  let current: Worktree | undefined = worktree
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const lineage = getLineageRenderInfo(current, lineageById, worktreeMap, cyclicLineageIds)
    if (lineage.state !== 'valid') {
      break
    }
    ancestors.push(lineage.parent)
    current = lineage.parent
  }
  return ancestors
}

function resolvedParents(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): Map<Worktree, Worktree> {
  const projection = getLineageProjection(lineageById, rows)
  if (!projection.parents) {
    const cyclic = new Set<Worktree>()
    projection.parents = resolveWorktreeLineageParents(
      [...rows.values()],
      (row) => getProjectedWorktreeLineage(row, lineageById),
      cyclic
    )
    projection.cyclicLineageIds = new Set([...cyclic].map((row) => row.id))
  }
  return projection.parents
}

export function getSidebarLineageParent(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>
): Worktree | undefined {
  return resolvedParents(lineageById, rowsByHostIdentity).get(worktree)
}

/**
 * The row each row nests under in the sidebar, by host identity; a row on a lineage cycle nests
 * under nothing. Memoized on both inputs, which callers replace rather than mutate.
 */
export function getSidebarLineageParentsByIdentity(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>
): ReadonlyMap<string, Worktree> {
  const projection = getLineageProjection(lineageById, rowsByHostIdentity)
  if (projection.sidebarParentByIdentity) {
    return projection.sidebarParentByIdentity
  }
  const parentByIdentity = new Map<string, Worktree>()
  for (const [identity, row] of rowsByHostIdentity) {
    const parent = getSidebarLineageParent(row, lineageById, rowsByHostIdentity)
    if (parent) {
      parentByIdentity.set(identity, parent)
    }
  }
  projection.sidebarParentByIdentity = parentByIdentity
  return parentByIdentity
}

/** The rows a worktree nests under in the sidebar, nearest first; a lineage cycle nests nothing. */
export function getSidebarLineageAncestors(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): Worktree[] {
  const ancestors: Worktree[] = []
  const seen = new Set([getWorktreeHostIdentity(worktree)])
  let current = worktree
  while (!cyclicLineageIds.has(current.id)) {
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
