import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import { buildWorktreeComparator, type SortBy } from './smart-sort'
import { IDLE, type WorktreeAttention } from './smart-attention'
import { countActiveWorkspaceFilters } from '../../../../shared/workspace-view/workspace-row-filters'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isWorkspaceOwnedBySomeoneElse } from '../../../../shared/workspace-creator-visibility'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildCliWorkspaceProvenance } from '../../../../shared/cli-workspace-provenance'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'

// Parity with the sidebar's own filter chain and comparator as they stood before the shared
// Workspace options evaluator, over every combination of the filter toggles.

const repos: Repo[] = [
  { id: 'git', path: '/git', displayName: 'Git', badgeColor: '#000', addedAt: 0 },
  {
    id: 'folder',
    path: '/folder',
    displayName: 'Folder',
    badgeColor: '#111',
    addedAt: 0,
    kind: 'folder'
  },
  {
    id: 'remote',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#222',
    addedAt: 0,
    executionHostId: 'runtime:env'
  }
]
const repoMap = new Map(repos.map((repo) => [repo.id, repo]))

function row(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'git',
    path: `/w/${id}`,
    head: 'abc1234',
    branch: `refs/heads/${id}`,
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
    lastActivityAt: 0,
    ...overrides
  }
}

const rows: Worktree[] = [
  row('main', { isMainWorktree: true, branch: 'refs/heads/main' }),
  row('main-detached', { isMainWorktree: true, branch: '' }),
  row('provisioned', { isMainWorktree: true, ephemeralVmCheckoutMode: 'provisioned-root' }),
  row('folder-root', { repoId: 'folder', isMainWorktree: true, branch: '', head: '' }),
  row('awake', { lastActivityAt: 5 }),
  row('automation', {
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'a',
      automationNameSnapshot: 'Nightly',
      automationRunId: 'r',
      automationRunTitleSnapshot: 'Run',
      createdAt: 0,
      executionTargetType: 'local',
      executionTargetId: 'p',
      projectId: 'p',
      hostId: 'local'
    }
  }),
  row('cli', { cliProvenance: buildCliWorkspaceProvenance({}, { createdAt: 0 }) }),
  row('detached', { branch: '', head: 'deadbeef' }),
  row('synthesized', { branch: '', head: '' }),
  row('host-made', { creatorProvenance: { kind: 'host' } }),
  row('remote', { repoId: 'remote', sortOrder: 3, manualOrder: 1, createdAt: 100 }),
  row('orphan', { repoId: 'gone' }),
  row('archived', { isArchived: true })
]

const tab = (id: string, worktreeId: string): TerminalTab => ({
  id,
  ptyId: `pty-${id}`,
  worktreeId,
  title: id,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})
const tabsByWorktree = {
  awake: [tab('t1', 'awake')],
  'main-detached': [tab('t2', 'main-detached')]
}
const ptyIdsByTabId = { t1: ['pty-t1'], t2: ['pty-t2'] }

const HOST_SCOPES: (ExecutionHostId[] | null)[] = [null, ['local'], ['runtime:env']]

type Toggles = {
  showSleepingWorkspaces: boolean
  alwaysShowDefaultBranchWorkspace: boolean | undefined
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  filterRepoIds: string[]
  visibleWorkspaceHostIds: ExecutionHostId[] | null
}

function* everyToggleCombination(): Generator<Toggles> {
  const bools = [false, true]
  for (const showSleepingWorkspaces of bools) {
    for (const alwaysShowDefaultBranchWorkspace of [undefined, true, false]) {
      for (const hideDefaultBranchWorkspace of bools) {
        for (const hideAutomationGeneratedWorkspaces of bools) {
          for (const hideCliCreatedWorkspaces of bools) {
            for (const hideDetachedHeadWorkspaces of bools) {
              for (const hideWorkspacesFromOtherDevices of bools) {
                for (const filterRepoIds of [[], ['git'], ['remote', 'stale']]) {
                  for (const visibleWorkspaceHostIds of HOST_SCOPES) {
                    yield {
                      showSleepingWorkspaces,
                      alwaysShowDefaultBranchWorkspace,
                      hideDefaultBranchWorkspace,
                      hideAutomationGeneratedWorkspaces,
                      hideCliCreatedWorkspaces,
                      hideDetachedHeadWorkspaces,
                      hideWorkspacesFromOtherDevices,
                      filterRepoIds,
                      visibleWorkspaceHostIds
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

// The sidebar's filter chain before the shared evaluator, verbatim apart from inlined predicates.
function previousDesktopFilter(t: Toggles): string[] {
  const detached = (w: Worktree) =>
    w.branch.replace(/^refs\/heads\//, '').trim() === '' && w.head.trim().slice(0, 7) !== ''
  const defaultBranch = (w: Worktree, repo: Repo | undefined) =>
    w.isMainWorktree &&
    w.ephemeralVmCheckoutMode !== 'provisioned-root' &&
    (w.branch.trim() !== '' || repo?.kind === 'folder')
  let all = rows.filter((w) => !w.isArchived)
  if (t.hideWorkspacesFromOtherDevices) {
    all = all.filter((w) => !isWorkspaceOwnedBySomeoneElse(w, new Map()))
  }
  if (t.hideDefaultBranchWorkspace) {
    all = all.filter((w) => !defaultBranch(w, repoMap.get(w.repoId)))
  }
  if (t.hideAutomationGeneratedWorkspaces) {
    all = all.filter((w) => w.automationProvenance?.kind !== 'created-by-automation')
  }
  if (t.hideCliCreatedWorkspaces) {
    all = all.filter((w) => w.cliProvenance?.kind !== 'created-by-cli')
  }
  if (t.hideDetachedHeadWorkspaces) {
    all = all.filter((w) => !detached(w))
  }
  if (t.visibleWorkspaceHostIds) {
    const hostIds = new Set(t.visibleWorkspaceHostIds)
    all = all.filter((w) => {
      const repo = repoMap.get(w.repoId)
      return repo ? hostIds.has(getWorktreeExecutionHostId(w, repo, 'local')) : false
    })
  }
  if (t.filterRepoIds.length > 0) {
    all = all.filter((w) => t.filterRepoIds.includes(w.repoId))
  }
  if (!t.showSleepingWorkspaces) {
    all = all.filter(
      (w) =>
        (t.alwaysShowDefaultBranchWorkspace !== false && w.isMainWorktree) ||
        !isInactiveWorkspace(w.id, tabsByWorktree, ptyIdsByTabId, {}, new Set(), new Set())
    )
  }
  return all.map((w) => w.id)
}

function previousDesktopFilterCount(t: Toggles): number {
  const sleeping = !t.showSleepingWorkspaces
  const exemption = sleeping && t.alwaysShowDefaultBranchWorkspace === false
  return (
    (sleeping ? 1 : 0) +
    (t.hideDefaultBranchWorkspace ? 1 : 0) +
    (t.hideAutomationGeneratedWorkspaces ? 1 : 0) +
    (t.hideCliCreatedWorkspaces ? 1 : 0) +
    (t.hideDetachedHeadWorkspaces ? 1 : 0) +
    (t.hideWorkspacesFromOtherDevices ? 1 : 0) +
    (exemption ? 1 : 0) +
    (t.visibleWorkspaceHostIds !== null ? 1 : 0) +
    repos.filter((repo) => t.filterRepoIds.includes(repo.id)).length
  )
}

describe('the shared Workspace options evaluator matches the sidebar it replaced', () => {
  it('keeps the same rows under every toggle combination', () => {
    let combinations = 0
    for (const t of everyToggleCombination()) {
      combinations += 1
      const visible = computeVisibleWorktreeIds(
        { all: rows },
        rows.map((w) => w.id),
        {
          ...t,
          tabsByWorktree,
          ptyIdsByTabId,
          browserTabsByWorktree: {},
          worktreeIdsWithLiveAgent: new Set(),
          pairedDeviceIdsByEnvironment: new Map(),
          repoMap,
          workspaceHostScope: 'all',
          defaultHostId: 'local',
          worktreeLineageById: {}
        }
      )
      expect(visible, JSON.stringify(t)).toEqual(previousDesktopFilter(t))
    }
    expect(combinations).toBe(2 * 3 * 2 ** 5 * 3 * 3)
  })

  it('counts the same badge under every toggle combination', () => {
    for (const t of everyToggleCombination()) {
      const count = countActiveWorkspaceFilters(
        {
          ...t,
          hideSleepingWorkspaces: !t.showSleepingWorkspaces,
          visibleHostIds: t.visibleWorkspaceHostIds
        },
        repos.map((repo) => repo.id)
      )
      expect(count, JSON.stringify(t)).toBe(previousDesktopFilterCount(t))
    }
  })
})

// The sidebar comparator before the shared evaluator, verbatim apart from the label lookup.
function previousDesktopComparator(sortBy: SortBy, now: number) {
  const label = (w: Worktree) => w.displayName
  const recent = (w: Worktree) =>
    w.createdAt === undefined || now >= w.createdAt + 5 * 60 * 1000
      ? w.lastActivityAt
      : Math.max(w.lastActivityAt, w.createdAt + 5 * 60 * 1000)
  return (a: Worktree, b: Worktree): number => {
    switch (sortBy) {
      case 'name':
        return label(a).localeCompare(label(b))
      case 'smart':
      case 'recent':
        return recent(b) - recent(a) || label(a).localeCompare(label(b))
      case 'repo': {
        const cmp = (repoMap.get(a.repoId)?.displayName ?? '').localeCompare(
          repoMap.get(b.repoId)?.displayName ?? ''
        )
        return cmp !== 0 ? cmp : label(a).localeCompare(label(b))
      }
      case 'manual':
        return (
          (b.manualOrder ?? b.sortOrder) - (a.manualOrder ?? a.sortOrder) ||
          label(a).localeCompare(label(b))
        )
    }
  }
}

describe('the shared comparator matches the sidebar comparator it replaced', () => {
  const sortRows = rows.map((w, index) => ({
    ...w,
    displayName: `${String.fromCharCode(122 - index)}-${w.id}`,
    sortOrder: (index * 7) % 5,
    lastActivityAt: (index * 3) % 4,
    ...(index % 3 === 0 ? { manualOrder: index } : {}),
    ...(index % 4 === 0 ? { createdAt: 0 } : {})
  }))
  for (const sortBy of ['name', 'smart', 'recent', 'repo', 'manual'] as const) {
    it(`orders rows the same way by ${sortBy}`, () => {
      const now = 60_000
      // Idle attention for every row reduces smart to its recency tiebreak.
      const attention = new Map<string, WorktreeAttention>(sortRows.map((w) => [w.id, IDLE]))
      const actual = [...sortRows].sort(buildWorktreeComparator(sortBy, repoMap, now, attention))
      const expected = [...sortRows].sort(previousDesktopComparator(sortBy, now))
      expect(actual.map((w) => w.id)).toEqual(expected.map((w) => w.id))
    })
  }
})
