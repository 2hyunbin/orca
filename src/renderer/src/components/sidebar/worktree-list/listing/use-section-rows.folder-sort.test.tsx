// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { computeRenderedSidebarRows } from '../../rendered-sidebar-worktree-order'
import { useSidebarSectionRows } from './use-section-rows'

const initialState = useAppStore.getInitialState()
const projectGroup: ProjectGroup = {
  id: 'folders',
  name: 'Folders',
  parentPath: '/tmp/folders',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const folders: FolderWorkspace[] = ['2_b', '1_a', '3_c'].map((name, index) => ({
  id: name,
  name,
  projectGroupId: projectGroup.id,
  folderPath: `/tmp/folders/${name}`,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: index + 1,
  lastActivityAt: [30, 10, 20][index] ?? 0,
  createdAt: 1,
  updatedAt: 1,
  workspaceStatus: 'in-progress'
}))

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('folder sidebar Sort by', () => {
  for (const groupBy of ['repo', 'workspace-status', 'pr-status', 'none'] as const) {
    it(`honors Name and updates when the selected sort changes under ${groupBy}`, () => {
      useAppStore.setState({
        sortBy: 'name',
        groupBy,
        projectGroups: [projectGroup],
        folderWorkspaces: folders
      })
      const { result } = renderHook(() =>
        useSidebarSectionRows({
          groupBy,
          projectOrderBy: 'manual',
          pinnedDisplayPolicy: 'single-location',
          defaultHostId: 'local',
          worktrees: [],
          repos: [],
          repoMap: new Map(),
          worktreeMap: new Map(),
          worktreeLineageById: {},
          prCache: null,
          settings: initialState.settings,
          workspaceStatuses: cloneDefaultWorkspaceStatuses(),
          effectiveCollapsedGroups: new Set(),
          projectGrouping: { projects: [], projectHostSetups: [] },
          visibleReposForRows: [],
          visibleProjectGroupsForRows: [projectGroup],
          visibleFolderWorkspacesForRows: folders,
          importedWorktreesByRepo: new Map(),
          newExternalWorktreesInboxByRepo: new Map(),
          filterRepoIds: [],
          visibleWorkspaceHostIds: null,
          workspaceHostScope: 'all'
        })
      )
      const names = () =>
        result.current.sectionRows.flatMap((row) =>
          row.type === 'folder-workspace' ? [row.folderWorkspace.name] : []
        )
      expect(names()).toEqual(['1_a', '2_b', '3_c'])
      expect(
        computeRenderedSidebarRows(useAppStore.getState(), []).flatMap((row) =>
          row.type === 'folder-workspace' ? [row.folderWorkspace.name] : []
        )
      ).toEqual(names())
      act(() => useAppStore.setState({ sortBy: 'manual' }))
      expect(names()).toEqual(['3_c', '1_a', '2_b'])
      act(() => useAppStore.setState({ sortBy: 'recent' }))
      expect(names()).toEqual(['2_b', '3_c', '1_a'])
      act(() => useAppStore.setState({ sortBy: 'repo' }))
      expect(names()).toEqual(['1_a', '2_b', '3_c'])
      act(() => useAppStore.setState({ sortBy: 'smart' }))
      expect(names()).toEqual(['3_c', '1_a', '2_b'])
    })
  }
})
