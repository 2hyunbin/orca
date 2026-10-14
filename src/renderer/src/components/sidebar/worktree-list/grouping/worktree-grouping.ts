import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../../store/types'
import {
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey
} from '../../workspace-status'
import {
  compareFolderWorkspacesForDisplay,
  getFolderWorkspaceLaneKey,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import { PR_GROUP_META, PR_GROUP_ORDER, getPRGroupKey, getPRLaneKey } from './group-keys'
import type { PRGroupKey } from './group-keys'
import { addRepoIdToGroup } from './worktree-group-entry'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import {
  addItemToProjectSection,
  ensureProjectSectionForRepo,
  type ProjectGroupingIndex
} from '../../../../../../shared/project-section-grouping'
import { orderProjectSections } from '../../../../../../shared/project-section-order'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  WorktreeGroupBy
} from './row-types'

/** Lane label for a lane a folder workspace opened before any worktree did. */
function getLaneLabelForKey(
  key: string,
  groupBy: Exclude<WorktreeGroupBy, 'repo'>,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): string {
  if (groupBy === 'workspace-status') {
    const status = getWorkspaceStatusFromGroupKey(key, workspaceStatuses)
    return workspaceStatuses.find((entry) => entry.id === status)?.label ?? status ?? key
  }
  if (groupBy === 'pr-status') {
    return PR_GROUP_META[key.replace(/^pr:/, '') as PRGroupKey].label
  }
  return key
}

/** Buckets worktrees into their sections and returns them in render order. */
export function buildOrderedGroups(args: {
  groupBy: WorktreeGroupBy
  naturalWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  settings: AppState['settings'] | undefined
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectIndex: ProjectGroupingIndex | null
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  repoOrder: Map<string, number> | undefined
  projectOrderBy: ProjectOrderBy
  folderWorkspaces?: readonly RenderableFolderWorkspace[]
}): OrderedGroupEntry[] {
  const {
    groupBy,
    naturalWorktrees,
    repoMap,
    prCache,
    settings,
    workspaceStatuses,
    projectIndex,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    folderWorkspaces = []
  } = args

  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of naturalWorktrees) {
    if (groupBy === 'repo') {
      addItemToProjectSection(grouped, w, w.repoId, repoMap, projectIndex)
      continue
    }
    let key: string
    let label: string
    if (groupBy === 'workspace-status') {
      const workspaceStatus = getWorkspaceStatus(w, workspaceStatuses)
      key = getWorkspaceStatusGroupKey(workspaceStatus)
      label =
        workspaceStatuses.find((status) => status.id === workspaceStatus)?.label ?? workspaceStatus
    } else {
      const prGroup = getPRGroupKey(w, repoMap, prCache, settings)
      key = getPRLaneKey(prGroup)
      label = PR_GROUP_META[prGroup].label
    }
    if (!grouped.has(key)) {
      grouped.set(key, { label, items: [], repo: undefined, repoIds: new Set() })
    }
    const group = grouped.get(key)!
    group.items.push(w)
    addRepoIdToGroup(group, w.repoId)
  }
  // Why: folder workspaces are not worktrees, so they never appear in the loop
  // above. Bucketing them here — and creating the lane when no worktree opened
  // one — is what lets a folder workspace be the sole occupant of a lane (#15362).
  if (groupBy !== 'repo') {
    for (const pair of folderWorkspaces) {
      const key = getFolderWorkspaceLaneKey(pair, groupBy, workspaceStatuses)
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: getLaneLabelForKey(key, groupBy, workspaceStatuses),
          items: [],
          repo: undefined,
          repoIds: new Set()
        })
      }
      const group = grouped.get(key)!
      group.folderWorkspaces ??= []
      group.folderWorkspaces.push(pair)
    }
    for (const group of grouped.values()) {
      group.folderWorkspaces?.sort((left, right) =>
        compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
      )
    }
  }
  if (groupBy === 'repo') {
    // Why: repos can arrive before worktree scans, but stale IDs passed by
    // older snapshots must not render an "Unknown" project header.
    for (const repoId of placeholderRepoIds) {
      ensureProjectSectionForRepo(grouped, repoId, repoMap, projectIndex, { requireRepo: true })
    }
    for (const [repoId, candidate] of importedWorktreesByRepo) {
      ensureProjectSectionForRepo(grouped, repoId, repoMap, projectIndex, {
        fallbackRepo: candidate.repo
      })
    }
    // Why: the default policy removes pinned worktrees from natural groups,
    // but actionable inbox rows still need a project section to render in.
    for (const [repoId, candidate] of newExternalWorktreesInboxByRepo) {
      ensureProjectSectionForRepo(grouped, repoId, repoMap, projectIndex, {
        fallbackRepo: candidate.repo
      })
    }
    // Why: creating the first worktree in a repo leaves it with no group yet;
    // ensure one so the in-progress row nests under its repo instead of being
    // dropped.
    for (const repoId of pendingByRepo.keys()) {
      ensureProjectSectionForRepo(grouped, repoId, repoMap, projectIndex)
    }
  }

  const orderedGroups: OrderedGroupEntry[] = []
  if (groupBy === 'pr-status') {
    for (const prGroup of PR_GROUP_ORDER) {
      const key = `pr:${prGroup}`
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else if (groupBy === 'workspace-status') {
    // Why: status grouping is opt-in while the board drawer remains the wider
    // all-lanes drag target; keep the sidebar compact by omitting empty lanes.
    for (const status of workspaceStatuses) {
      const key = getWorkspaceStatusGroupKey(status.id)
      const group = grouped.get(key)
      if (group) {
        orderedGroups.push([key, group])
      }
    }
  } else {
    const entries = orderProjectSections(grouped, repoMap, repoOrder, projectOrderBy)
    // Why: large imported repo sets can have one group per repo; spreading
    // those entries into push can exceed V8's argument limit.
    for (const entry of entries) {
      orderedGroups.push(entry)
    }
  }
  return orderedGroups
}
