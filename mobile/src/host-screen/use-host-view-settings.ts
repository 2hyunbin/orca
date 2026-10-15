import { useCallback, useEffect } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { getMobileWorkspaceLineageGroupKey } from '../worktree/mobile-workspace-lineage'
import { WORKSPACE_SORT_OPTIONS as SORT_OPTIONS } from '../worktree/workspace-list-picker-options'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  type MobileGroupMode,
  type MobileSortMode,
  NO_FILTERS,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-sections'
import { readVisibleHostIds } from '../worktree/visible-host-rows'
import { hostViewSettingsRead, hostViewSettingsWrite } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'
import type { FilterState } from '../worktree/workspace-list-types'

export function useHostViewSettings(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: HostScreenState
}) {
  const { client, connState, hostId, state } = args
  const {
    clientRef,
    collapsedGroups,
    filters,
    groupMode,
    setCollapsedGroups,
    setFilters,
    setGroupMode,
    setSortMode,
    setVisibleHostIds,
    setWorkspaceStatuses,
    sortMode,
    viewStateRef,
    workspaceStatuses
  } = state

  useEffect(() => {
    viewStateRef.current = {
      groupMode,
      sortMode,
      filters,
      collapsedGroups: [...collapsedGroups],
      workspaceStatuses
    }
  }, [groupMode, sortMode, filters, collapsedGroups, workspaceStatuses])

  // Apply a MobileViewState onto the individual states and the snapshot ref in one shot.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewStateRef.current = next
    setGroupMode(next.groupMode)
    setSortMode(next.sortMode)
    setWorkspaceStatuses(next.workspaceStatuses)
    setCollapsedGroups(new Set(next.collapsedGroups))
    setFilters(next.filters)
  }, [])

  // Apply the change locally, then patch the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: Partial<MobileViewState>) => {
      const previous = viewStateRef.current
      const next: MobileViewState = { ...previous, ...patch }
      applyViewState(next)
      if (!client) {
        return
      }
      // Send only the touched fields: the host merges partial updates, so a stale
      // mirror can no longer revert sibling settings another client just changed
      // (STA-5781; supersedes the #8873 whole-payload special case).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next, previous)
      if (Object.keys(payload).length === 0) {
        return
      }
      void hostViewSettingsWrite.request(client, payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [client, applyViewState]
  )

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    try {
      const reply = await hostViewSettingsRead.request(requestClient)
      if (clientRef.current !== requestClient || hostId !== requestHostId) {
        return
      }
      const settings = hostViewSettingsRead.interpret(reply)
      if (!settings.accepted) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      const ui = settings.value as WorkspaceViewSettings | undefined
      if (!ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewStateRef.current, ui))
      setVisibleHostIds(readVisibleHostIds(ui.visibleWorkspaceHostIds))
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [client, connState, hostId, applyViewState])

  const handleSortChange = useCallback(
    (value: MobileSortMode) => {
      persistViewSettings({ sortMode: value })
    },
    [persistViewSettings]
  )

  const setFilter = useCallback(
    <Key extends keyof FilterState>(key: Key, value: FilterState[Key]) => {
      persistViewSettings({ filters: { ...viewStateRef.current.filters, [key]: value } })
    },
    [persistViewSettings]
  )

  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const current = viewStateRef.current.filters.filterRepoIds
      setFilter(
        'filterRepoIds',
        current.includes(repoId) ? current.filter((id) => id !== repoId) : [...current, repoId]
      )
    },
    [setFilter]
  )

  // Why every filter: Clear filters on the desktop resets them all, not only the ones shown here.
  const clearFilters = useCallback(() => {
    persistViewSettings({ filters: NO_FILTERS })
  }, [persistViewSettings])

  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? 'Recent'

  const handleGroupChange = useCallback(
    (value: MobileGroupMode) => {
      persistViewSettings({ groupMode: value })
    },
    [persistViewSettings]
  )

  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewStateRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) => toggleCollapsed(getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )

  return {
    clearFilters,
    handleGroupChange,
    handleSortChange,
    selectedSortLabel,
    syncViewSettingsFromDesktop,
    toggleCollapsed,
    setFilter,
    toggleRepoFilter,
    toggleWorktreeLineage
  }
}

export type HostViewSettings = ReturnType<typeof useHostViewSettings>
