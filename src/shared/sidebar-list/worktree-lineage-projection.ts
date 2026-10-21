import { folderWorkspaceToWorktree } from '../folder-workspace-worktree'
import type { FolderWorkspace } from '../folder-workspace-types'
import {
  getSavedWorktreeLineage,
  resolveWorktreeLineageParents
} from '../resolved-worktree-lineage'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'

export const getProjectedWorktreeLineage = getSavedWorktreeLineage

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

const rowIndexes = new WeakMap<readonly Worktree[], Map<string, Worktree>>()
export function getWorktreeLineageRows(rows: readonly Worktree[]): Map<string, Worktree> {
  let index = rowIndexes.get(rows)
  if (!index) {
    index = new Map(rows.map((row) => [getWorktreeHostIdentity(row), row]))
    rowIndexes.set(rows, index)
  }
  return index
}

const universes = new WeakMap<object, WeakMap<readonly FolderWorkspace[], Map<string, Worktree>>>()
const noFolders: readonly FolderWorkspace[] = []
export function getWorkspaceLineageRows(
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>,
  folders: readonly FolderWorkspace[] = noFolders
): Map<string, Worktree> {
  let byFolders = universes.get(worktreesByRepo)
  if (!byFolders) {
    byFolders = new WeakMap()
    universes.set(worktreesByRepo, byFolders)
  }
  let rows = byFolders.get(folders)
  if (!rows) {
    rows = getWorktreeLineageRows([
      ...Object.values(worktreesByRepo).flat(),
      ...folders.map(folderWorkspaceToWorktree)
    ])
    byFolders.set(folders, rows)
  }
  return rows
}

type LineageProjection = {
  parents: Map<Worktree, Worktree>
  children: Map<Worktree, Worktree[]>
  cyclicIdentities: Set<string>
  parentByIdentity: Map<string, Worktree>
}

const projections = new WeakMap<
  Readonly<Record<string, WorktreeLineage>>,
  WeakMap<ReadonlyMap<string, Worktree>, LineageProjection>
>()

/** Immutable complete snapshots share one graph; display filters never change identity uniqueness. */
export function getWorktreeLineageProjection(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): LineageProjection {
  let byRows = projections.get(lineageById)
  if (!byRows) {
    byRows = new WeakMap()
    projections.set(lineageById, byRows)
  }
  let projection = byRows.get(rows)
  if (!projection) {
    const cyclic = new Set<Worktree>()
    const parents = resolveWorktreeLineageParents(
      [...rows.values()],
      (row) => getSavedWorktreeLineage(row, lineageById),
      cyclic
    )
    const children = new Map<Worktree, Worktree[]>()
    for (const [child, parent] of parents) {
      const siblings = children.get(parent) ?? []
      siblings.push(child)
      children.set(parent, siblings)
    }
    projection = {
      parents,
      children,
      cyclicIdentities: new Set([...cyclic].map(getWorktreeHostIdentity)),
      parentByIdentity: new Map(
        [...parents]
          .filter(([, parent]) => !parent.isArchived)
          .map(([child, parent]) => [getWorktreeHostIdentity(child), parent])
      )
    }
    byRows.set(rows, projection)
  }
  return projection
}

export function getCyclicProjectedWorktreeLineageIds(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): Set<string> {
  return getWorktreeLineageProjection(lineageById, rows).cyclicIdentities
}

export function getLineageRenderInfo(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): LineageRenderInfo {
  const canonical = rows.get(getWorktreeHostIdentity(worktree)) ?? worktree
  const lineage = getSavedWorktreeLineage(canonical, lineageById)
  if (!lineage) {
    return { state: 'none' }
  }
  const parent = getWorktreeLineageProjection(lineageById, rows).parents.get(canonical)
  return parent ? { state: 'valid', lineage, parent } : { state: 'missing', lineage }
}

export function getSidebarLineageParent(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): Worktree | undefined {
  const parent = getWorktreeLineageProjection(lineageById, rows).parents.get(
    rows.get(getWorktreeHostIdentity(worktree)) ?? worktree
  )
  return parent?.isArchived ? undefined : parent
}

export function getSidebarLineageParentsByIdentity(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): ReadonlyMap<string, Worktree> {
  return getWorktreeLineageProjection(lineageById, rows).parentByIdentity
}

export function getSidebarLineageAncestors(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>
): Worktree[] {
  const ancestors: Worktree[] = []
  let parent = getSidebarLineageParent(worktree, lineageById, rows)
  while (parent) {
    ancestors.push(parent)
    parent = getSidebarLineageParent(parent, lineageById, rows)
  }
  return ancestors
}

export function getWorktreeLineageDescendants(
  row: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rows: ReadonlyMap<string, Worktree>,
  includeArchived = false
): Worktree[] {
  const { children } = getWorktreeLineageProjection(lineageById, rows)
  const descendants: Worktree[] = []
  const pending = [rows.get(getWorktreeHostIdentity(row)) ?? row]
  for (const parent of pending) {
    for (const child of children.get(parent) ?? []) {
      if (includeArchived || !child.isArchived) {
        descendants.push(child)
        pending.push(child)
      }
    }
  }
  return descendants
}
