import { useMemo } from 'react'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'
import {
  buildSectionRepoMap,
  buildSections,
  type FilterState,
  type ProjectSectionCatalog,
  type Section,
  type SectionRepo,
  type Worktree
} from './workspace-list-sections'
import { repoColor } from './repo-color'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
}

/** A repo's badge colour, else the colour its name hashes to. */
export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor' | 'displayName'>): string {
  return (typeof repo.badgeColor === 'string' && repo.badgeColor) || repoColor(repo.displayName)
}

/**
 * The repos the filter lists, as the desktop's project filter lists them: every catalog repo by
 * id, each host's separately. Before any catalog answers, the repos the rows name.
 */
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[]
): WorkspaceSectionRepo[] {
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], worktrees).values()]
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}

export function useWorkspaceSections(args: {
  displayWorktrees: Worktree[]
  sortMode: MobileSortMode
  filters: FilterState
  search: string
  groupMode: MobileGroupMode
  pinnedIds: Set<string>
  showPinnedInGroups: boolean
  projectCatalog: ProjectSectionCatalog
  /** Every catalog repo on every host, which is what the desktop's filter lists. */
  filterCatalogRepos: readonly SectionRepo[]
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): {
  sections: Section[]
  rawSections: Section[]
  uniqueRepos: WorkspaceSectionRepo[]
  /** Each row's repo by id, as the desktop's cards look theirs up for colour and icon. */
  repoById: ReadonlyMap<string, SectionRepo>
} {
  const {
    displayWorktrees,
    sortMode,
    filters,
    search,
    groupMode,
    pinnedIds,
    showPinnedInGroups,
    projectCatalog,
    filterCatalogRepos,
    collapsedGroups,
    workspaceStatuses
  } = args

  const uniqueRepos = useMemo(
    () => buildFilterRepos(filterCatalogRepos, displayWorktrees),
    [filterCatalogRepos, displayWorktrees]
  )

  const repoById = useMemo(
    () => buildSectionRepoMap(projectCatalog.repos, displayWorktrees),
    [projectCatalog.repos, displayWorktrees]
  )

  const rawSections = useMemo(
    () =>
      buildSections(
        displayWorktrees,
        sortMode,
        filters,
        search,
        groupMode,
        pinnedIds,
        projectCatalog,
        workspaceStatuses,
        collapsedGroups,
        showPinnedInGroups
      ),
    [
      displayWorktrees,
      sortMode,
      filters,
      search,
      groupMode,
      pinnedIds,
      projectCatalog,
      workspaceStatuses,
      collapsedGroups,
      showPinnedInGroups
    ]
  )

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.key) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )

  return { sections, rawSections, uniqueRepos, repoById }
}
