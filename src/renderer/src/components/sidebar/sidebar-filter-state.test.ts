import { describe, expect, it } from 'vitest'
import { computeClearFilterActions, sidebarHasActiveFilters } from './visible-worktrees'
import { isDefaultBranchWorkspace } from '../../../../shared/workspace-view/workspace-row-kinds'
import type { Worktree } from '../../../../shared/worktree/types'

const gitRepo = { kind: 'git' } as const

function makeWorktree(id: string, repoId = 'repo1'): Worktree {
  return {
    id,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

type FilterState = Parameters<typeof sidebarHasActiveFilters>[0]

function filterState(overrides: Partial<FilterState> = {}): FilterState {
  return {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    workspaceHostScope: 'all',
    ...overrides
  }
}

describe('isDefaultBranchWorkspace', () => {
  it('returns true for a branch-backed main worktree', () => {
    const main = makeWorktree('main')
    main.isMainWorktree = true
    expect(isDefaultBranchWorkspace(main, gitRepo)).toBe(true)
  })

  it('returns false for an empty-branch git main (detached HEAD or offline SSH row)', () => {
    const detached = makeWorktree('detached')
    detached.isMainWorktree = true
    detached.branch = ''
    expect(isDefaultBranchWorkspace(detached, gitRepo)).toBe(false)
  })

  it('returns true for a folder project root, which has no branch', () => {
    const folder = makeWorktree('folder')
    folder.isMainWorktree = true
    folder.branch = ''
    folder.head = ''
    expect(isDefaultBranchWorkspace(folder, { kind: 'folder' })).toBe(true)
  })

  it('returns false for non-main worktrees even on the default branch', () => {
    const feature = makeWorktree('feature')
    expect(isDefaultBranchWorkspace(feature, gitRepo)).toBe(false)
  })

  it('keeps a provisioned root visible as the recipe-created workspace', () => {
    const provisionedRoot = makeWorktree('provisioned-root')
    provisionedRoot.isMainWorktree = true
    provisionedRoot.ephemeralVmCheckoutMode = 'provisioned-root'
    expect(isDefaultBranchWorkspace(provisionedRoot, gitRepo)).toBe(false)
  })
})

describe('sidebarHasActiveFilters', () => {
  it('returns false when no filters are active', () => {
    expect(sidebarHasActiveFilters(filterState())).toBe(false)
  })

  it('returns true when only hideDefaultBranchWorkspace is active', () => {
    // Why: regression guard for the empty-sidebar escape hatch. If hide is
    // omitted from the filter union, a user whose only worktree is the
    // default-branch row sees "No workspaces found" with no way back.
    expect(sidebarHasActiveFilters(filterState({ hideDefaultBranchWorkspace: true }))).toBe(true)
  })

  it('returns true when only automation-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideAutomationGeneratedWorkspaces: true }))).toBe(
      true
    )
  })

  it('returns true when only CLI-created workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideCliCreatedWorkspaces: true }))).toBe(true)
  })

  it('returns true when only detached-HEAD workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideDetachedHeadWorkspaces: true }))).toBe(true)
  })

  it('returns true when workspaces from other devices are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ hideWorkspacesFromOtherDevices: true }))).toBe(
      true
    )
  })

  it('returns true when sleeping workspaces are hidden', () => {
    expect(sidebarHasActiveFilters(filterState({ showSleepingWorkspaces: false }))).toBe(true)
  })

  it('returns true when only filterRepoIds is non-empty', () => {
    expect(sidebarHasActiveFilters(filterState({ filterRepoIds: ['repo1'] }))).toBe(true)
  })

  it('counts an opted-out default-branch exemption as an active filter', () => {
    expect(sidebarHasActiveFilters(filterState({ alwaysShowDefaultBranchWorkspace: false }))).toBe(
      true
    )
  })

  it('treats a missing default-branch exemption as the default, not a filter', () => {
    const { alwaysShowDefaultBranchWorkspace: _omitted, ...withoutFlag } = filterState()
    expect(sidebarHasActiveFilters(withoutFlag)).toBe(false)
  })

  it('returns true when only host visibility is narrowed', () => {
    expect(sidebarHasActiveFilters(filterState({ visibleWorkspaceHostIds: ['local'] }))).toBe(true)
  })
})

describe('computeClearFilterActions', () => {
  it('names nothing when nothing is set', () => {
    expect(computeClearFilterActions(filterState())).toEqual([])
  })

  it.each([
    [{ hideDefaultBranchWorkspace: true }, ['hideDefaultBranchWorkspace']],
    [{ hideAutomationGeneratedWorkspaces: true }, ['hideAutomationGeneratedWorkspaces']],
    [{ hideCliCreatedWorkspaces: true }, ['hideCliCreatedWorkspaces']],
    [{ hideDetachedHeadWorkspaces: true }, ['hideDetachedHeadWorkspaces']],
    [{ hideWorkspacesFromOtherDevices: true }, ['hideWorkspacesFromOtherDevices']],
    [{ alwaysShowDefaultBranchWorkspace: false }, ['alwaysShowDefaultBranchWorkspace']],
    // The legacy single-host scope narrows with no host list saved, so Clear resets it too.
    [{ workspaceHostScope: 'ssh:host-1' as const }, ['visibleHostIds']]
  ] as const)('names only the filter that is set (%o)', (overrides, expected) => {
    expect(computeClearFilterActions(filterState(overrides))).toEqual(expected)
  })

  it('names every active filter at once, and nothing already at its default', () => {
    expect(
      computeClearFilterActions(
        filterState({
          showSleepingWorkspaces: false,
          filterRepoIds: ['repo1', 'repo2'],
          hideDefaultBranchWorkspace: true,
          hideAutomationGeneratedWorkspaces: true,
          visibleWorkspaceHostIds: ['local']
        })
      )
    ).toEqual([
      'hideSleepingWorkspaces',
      'hideDefaultBranchWorkspace',
      'hideAutomationGeneratedWorkspaces',
      'filterRepoIds',
      'visibleHostIds'
    ])
  })
})
