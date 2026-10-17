import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey
} from '../workspace-statuses'
import {
  compareFolderWorkspacesForDisplay,
  getFolderWorkspaceLaneKey,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import { PR_GROUP_ORDER, getPRGroupKey, getPRLaneKey } from './group-keys'
import type { PRGroupKey, SidebarListLabels, SidebarListSettings } from './group-keys'
import type { OrderedGroupEntry, WorktreeGroupEntry } from './worktree-group-entry'
import { buildProjectSections, type ProjectGroupingIndex } from '../project-section-grouping'
import { orderProjectSections } from '../project-section-order'
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
  workspaceStatuses: readonly WorkspaceStatusDefinition[],
  labels: SidebarListLabels
): string {
  if (groupBy === 'workspace-status') {
    const status = getWorkspaceStatusFromGroupKey(key, workspaceStatuses)
    return workspaceStatuses.find((entry) => entry.id === status)?.label ?? status ?? key
  }
  if (groupBy === 'pr-status') {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pr-status lane keys come from getPRLaneKey(PRGroupKey).
    return labels.prGroups[key.replace(/^pr:/, '') as PRGroupKey]
  }
  return key
}

/** Buckets worktrees into their sections and returns them in render order. */
export function buildOrderedGroups(args: {
  groupBy: WorktreeGroupBy
  naturalWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  settings: SidebarListSettings | undefined
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectIndex: ProjectGroupingIndex | null
  displayRootByIdentity?: ReadonlyMap<string, Worktree>
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  repoOrder: Map<string, number> | undefined
  projectOrderBy: ProjectOrderBy
  folderWorkspaces?: readonly RenderableFolderWorkspace[]
  labels: SidebarListLabels
}): OrderedGroupEntry[] {
  const {
    groupBy,
    naturalWorktrees,
    repoMap,
    prCache,
    settings,
    workspaceStatuses,
    projectIndex,
    displayRootByIdentity,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    folderWorkspaces = [],
    labels
  } = args

  if (groupBy === 'repo') {
    // Why shared: the paired phone builds its Project sections with this same function.
    return buildProjectSections({
      items: naturalWorktrees,
      repoIdOf: (worktree) => worktree.repoId,
      displayRepoIdOf: (worktree) =>
        (displayRootByIdentity?.get(getWorktreeHostIdentity(worktree)) ?? worktree).repoId,
      repoMap,
      projectIndex,
      placeholderRepoIds,
      noticeRepos: [
        ...[...importedWorktreesByRepo].map(
          ([repoId, candidate]) => [repoId, candidate.repo] as const
        ),
        ...[...newExternalWorktreesInboxByRepo].map(
          ([repoId, candidate]) => [repoId, candidate.repo] as const
        )
      ],
      pendingRepoIds: pendingByRepo.keys(),
      repoOrder,
      projectOrderBy
    })
  }

  const grouped = new Map<string, WorktreeGroupEntry>()
  for (const w of naturalWorktrees) {
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
      label = labels.prGroups[prGroup]
    }
    if (!grouped.has(key)) {
      grouped.set(key, { label, items: [], repo: undefined, repoIds: new Set() })
    }
    const group = grouped.get(key)!
    group.items.push(w)
    group.repoIds.add(w.repoId)
  }
  // Why: folder workspaces are not worktrees, so they never appear in the loop
  // above. Bucketing them here — and creating the lane when no worktree opened
  // one — is what lets a folder workspace be the sole occupant of a lane (#15362).
  for (const pair of folderWorkspaces) {
    const key = getFolderWorkspaceLaneKey(pair, groupBy, workspaceStatuses)
    if (!grouped.has(key)) {
      grouped.set(key, {
        label: getLaneLabelForKey(key, groupBy, workspaceStatuses, labels),
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
