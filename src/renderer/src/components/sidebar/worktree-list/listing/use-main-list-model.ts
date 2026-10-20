import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useDesktopSidebarFeed } from '@/lib/desktop-sidebar-feed'
import {
  overlaySidebarPendingLayer,
  readSidebarPendingLayer,
  subscribeSidebarPendingLayer
} from '@/lib/sidebar-pending-layer'
import { useSidebarListSession } from '@/lib/sidebar-list-session'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import {
  getLocalExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'
import {
  planSidebarFeedRows,
  renderSidebarFeedRows,
  type SidebarFeedView
} from '../../../../../../shared/sidebar-list/sidebar-feed-rows'
import {
  indexSidebarFeed,
  rankSidebarFeedWorktrees
} from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import {
  filterReposForVisibleHosts,
  getVisibleSidebarHostIdSet
} from '../../../../../../shared/sidebar-list/host-filtering'
import { mergeDraggedHostSectionOrder } from '../../../../../../shared/sidebar-list/host-section-order'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { sidebarWorkspaceRowFilters } from '../../sidebar-filter-actions'
import type { SidebarListModel, SidebarListModelArgs } from './sidebar-list-model'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'
import { collectRenderedSidebarRowKeys } from './rendered-row-keys'
import { useEffectiveCollapsedGroups } from './use-collapsed-groups'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import { useOrderHeldWhileEngaged } from './use-order-hold'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import type { WorkspaceCreation } from '../../../../../../shared/sidebar-list/workspace-creations'

const NO_FEED: SidebarFeedDomains = {
  workspaces: new Map(),
  activity: new Map(),
  review: new Map(),
  creations: new Map(),
  pairedServerHosts: new Map(),
  pairedServerRows: new Map(),
  repoIcons: new Map(),
  desktop: null,
  retention: null
}
const NO_REPOS: SidebarListModelArgs['repos'] = []
const NO_PROJECT_GROUPS: SidebarListModelArgs['projectGroups'] = []
// The window renders its own collapse, so planning never re-runs on a toggle.
const PLANNED_UNCOLLAPSED: ReadonlySet<string> = new Set()

/** The creations the window draws: its own, with main's record where main runs one. Main also lists
 *  creations the window holds no entry for (finished here, or started elsewhere); their row draws
 *  nothing, so listing them leaves an empty gap that closes, shifting every row below it. */
export function withWindowCreations(
  domains: SidebarFeedDomains,
  pendingCreationKeys: readonly string[]
): SidebarFeedDomains {
  if (pendingCreationKeys.length === 0 && domains.creations.size === 0) {
    return domains
  }
  const creations = new Map<string, WorkspaceCreation>()
  for (const key of pendingCreationKeys) {
    const separator = key.indexOf(' ')
    const creationId = key.slice(0, separator)
    creations.set(
      creationId,
      domains.creations.get(creationId) ?? { repoId: key.slice(separator + 1) }
    )
  }
  return { ...domains, creations }
}

function folderRecordKey(id: string, hostId: string | null | undefined): string {
  return `${parseExecutionHostId(hostId)?.id ?? ''}\0${id}`
}

// Main's rows answer for the list; the window's own records answer for what a card shows.
function windowRecordOf(records: ReadonlyMap<string, Worktree>, worktree: Worktree): Worktree {
  return records.get(getWorktreeHostIdentity(worktree)) ?? worktree
}

function windowFolderRecordOf(
  records: ReadonlyMap<string, FolderWorkspace>,
  folder: FolderWorkspace
): FolderWorkspace {
  return records.get(folderRecordKey(folder.id, folder.executionHostId)) ?? folder
}

/**
 * Switch point. The list built from main's inputs, by the builder the phone runs: the window adds
 * only screen state (hover hold, collapse, host drag, agent-send reveal), its desktop-only cards,
 * its own view settings and host order, and its row writes main has not shown yet. Cards render
 * the window's own records for the rows main lists.
 */
export function useMainSidebarListModel(args: SidebarListModelArgs): SidebarListModel {
  const { filterState, sortBy, groupBy, defaultHostId, settings } = args
  useSidebarListSession()
  // Main's rows can land before this window has its saved view and project catalog, and the catalog
  // before main's rows; either half alone draws rows under default grouping and unnamed headers, or
  // headers with no rows, then regroups. Nothing draws until both are in.
  const catalogHydrated = useAppStore((s) => s.startupLocalCatalogHydrated)
  const installedFeed = useDesktopSidebarFeed()
  const ready = catalogHydrated && installedFeed !== null
  const feed = ready ? installedFeed : null
  const repos = ready ? args.repos : NO_REPOS
  const projectGroups = ready ? args.projectGroups : NO_PROJECT_GROUPS
  const pending = useSyncExternalStore(subscribeSidebarPendingLayer, readSidebarPendingLayer)
  const pendingCreationKeys = useAppStore(
    useShallow((s) => selectPendingWorktreeCreationKeys(s.pendingWorktreeCreations))
  )
  const workspaceHostOrder = useAppStore((s) => s.workspaceHostOrder)
  const setWorkspaceHostOrder = useAppStore((s) => s.setWorkspaceHostOrder)
  const domains = useMemo(
    () =>
      feed
        ? withWindowCreations(
            overlaySidebarPendingLayer(feed.domains, pending, {
              repos,
              lineageById: args.worktreeLineageById
            }),
            pendingCreationKeys
          )
        : NO_FEED,
    [feed, pending, pendingCreationKeys, repos, args.worktreeLineageById]
  )
  const catalog = useMemo(
    () => ({ repos, projectGroups, projectGrouping: args.projectGrouping }),
    [repos, projectGroups, args.projectGrouping]
  )
  const view: SidebarFeedView = useMemo(
    () => ({
      groupBy,
      sortBy,
      projectOrderBy: args.projectOrderBy,
      collapsedGroups: PLANNED_UNCOLLAPSED,
      filters: sidebarWorkspaceRowFilters(filterState),
      workspaceHostScope: filterState.workspaceHostScope,
      visibleWorkspaceHostIds: filterState.visibleWorkspaceHostIds,
      workspaceStatuses: args.workspaceStatuses,
      pinnedDisplayPolicy: args.pinnedDisplayPolicy,
      defaultHostId,
      hostLabelOverrides: getHostDisplayLabelOverrides(settings),
      localHostLabel: getLocalExecutionHostLabel(),
      workspaceHostOrder
    }),
    [
      groupBy,
      sortBy,
      args.projectOrderBy,
      filterState,
      args.workspaceStatuses,
      args.pinnedDisplayPolicy,
      defaultHostId,
      settings,
      workspaceHostOrder
    ]
  )
  const index = useMemo(() => indexSidebarFeed(domains, repos), [domains, repos])
  const ranked = useMemo(() => rankSidebarFeedWorktrees(index, sortBy), [index, sortBy])
  const rankedIds = useOrderHeldWhileEngaged(useReusedArrayIdentity(ranked), sortBy)

  const visibleReposForRows = useMemo(
    () =>
      filterReposForVisibleHosts(
        repos,
        getVisibleSidebarHostIdSet(
          filterState.visibleWorkspaceHostIds,
          filterState.workspaceHostScope
        ),
        defaultHostId
      ),
    [repos, filterState.visibleWorkspaceHostIds, filterState.workspaceHostScope, defaultHostId]
  )
  const externalWorktreeCards = useSidebarExternalWorktreeCards({
    repos,
    visibleReposForRows,
    detectedWorktreesByRepo: args.detectedWorktreesByRepo,
    filterRepoIds: filterState.filterRepoIds
  })
  const { importedWorktreesByRepo, newExternalWorktreesInboxByRepo } = externalWorktreeCards
  const planned = useMemo(
    () =>
      planSidebarFeedRows(domains, index, catalog, view, rankedIds, {
        forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
          ? [args.agentSendTargetWorktreeId]
          : undefined,
        importedWorktreesByRepo,
        newExternalWorktreesInboxByRepo
      }),
    [
      domains,
      index,
      catalog,
      view,
      rankedIds,
      args.agentSendTargetWorktreeId,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo
    ]
  )

  const worktreeByIdentity = useMemo(
    () =>
      new Map(args.allWorktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])),
    [args.allWorktrees]
  )
  const folderByKey = useMemo(
    () =>
      new Map(
        args.folderWorkspaces.map((folder) => [
          folderRecordKey(folder.id, getFolderWorkspaceHostId(folder, args.projectGroups)),
          folder
        ])
      ),
    [args.folderWorkspaces, args.projectGroups]
  )
  const visibleWorktrees = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleWorktrees.map((worktree) => windowRecordOf(worktreeByIdentity, worktree)),
      [planned.visibleWorktrees, worktreeByIdentity]
    )
  )
  const visibleFolderWorkspacesForRows = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleFolderWorkspaces.map((folder) => windowFolderRecordOf(folderByKey, folder)),
      [planned.visibleFolderWorkspaces, folderByKey]
    )
  )

  const effectiveCollapsedGroups = useEffectiveCollapsedGroups({
    occurrencePlan: planned.plan.occurrencePlan,
    hostScopedGroups: planned.hostScoped,
    collapsedGroups: args.collapsedGroups,
    agentSendTargetWorktreeId: args.agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy: args.pinnedDisplayPolicy,
    worktrees: planned.visibleWorktrees,
    visibleWorktrees: planned.visibleWorktrees,
    filterRepoIds: filterState.filterRepoIds,
    repoMap: index.repoMap,
    worktreeMap: planned.worktreeMap,
    worktreeLineageById: planned.lineageById,
    prCache: args.prCache,
    workspaceStatuses: args.workspaceStatuses,
    projectGroups: planned.visibleProjectGroups,
    projectGrouping: args.projectGrouping,
    folderWorkspaces: planned.visibleFolderWorkspaces,
    defaultHostId
  })
  const [hostDragActive, setHostDragActive] = useState(false)
  const rendered = useMemo(
    () => renderSidebarFeedRows(planned, view, effectiveCollapsedGroups, hostDragActive),
    [planned, view, effectiveCollapsedGroups, hostDragActive]
  )
  const sectionRows = useMemo(
    () =>
      rendered.sectionRows.map((row): HostSectionRow => {
        if (row.type === 'item') {
          const worktree = windowRecordOf(worktreeByIdentity, row.worktree)
          return worktree === row.worktree ? row : { ...row, worktree }
        }
        if (row.type === 'folder-workspace') {
          const folderWorkspace = windowFolderRecordOf(folderByKey, row.folderWorkspace)
          return folderWorkspace === row.folderWorkspace ? row : { ...row, folderWorkspace }
        }
        return row
      }),
    [rendered.sectionRows, worktreeByIdentity, folderByKey]
  )
  const renderedSidebarRowKeys = useMemo(
    () => collectRenderedSidebarRowKeys(sectionRows),
    [sectionRows]
  )
  const allRepoIds = useMemo(() => repos.map((repo) => repo.id), [repos])
  const { orderedHostOptions } = planned
  const handleReorderHostSections = useCallback(
    (orderedVisibleHostIds: ExecutionHostId[]) =>
      setWorkspaceHostOrder(
        mergeDraggedHostSectionOrder(
          orderedVisibleHostIds,
          workspaceHostOrder,
          orderedHostOptions.map((host) => host.id)
        )
      ),
    [orderedHostOptions, setWorkspaceHostOrder, workspaceHostOrder]
  )

  return {
    visibleWorktrees,
    visibleScope: {
      visibleReposForRows,
      visibleProjectGroupsForRows: planned.visibleProjectGroups,
      visibleFolderWorkspacesForRows
    },
    externalWorktreeCards,
    rowModel: {
      occurrencePlan: planned.plan.occurrencePlan,
      hostOptions: planned.orderedHostOptions,
      effectiveCollapsedGroups,
      rows: rendered.rows,
      sectionRows,
      renderedSidebarRowKeys,
      allRepoIds,
      placeholderRepoIds: planned.placeholderRepoIds,
      handleReorderHostSections,
      setHostDragActive
    }
  }
}
