import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import {
  isFolderWorkspaceHiddenBySidebarSwitch,
  isHiddenBySidebarSwitch,
  type SidebarSwitchInputs
} from './sidebar-switch-hidden-workspace'

const REPO: Repo = { id: 'repo1', path: '/repo1', displayName: 'r', badgeColor: '#000', addedAt: 0 }

function inputs(overrides: Partial<SidebarSwitchInputs> = {}): SidebarSwitchInputs {
  return {
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    worktreeIdsWithStructuredChat: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    ...overrides
  }
}

function row(overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({ id: 'wt', repoId: REPO.id, ...overrides })
}

const AUTOMATION: NonNullable<Worktree['automationProvenance']> = {
  kind: 'created-by-automation',
  automationId: 'a',
  automationNameSnapshot: 'a',
  automationRunId: 'r',
  automationRunTitleSnapshot: 'r',
  createdAt: 0,
  executionTargetType: 'local',
  executionTargetId: 'local',
  projectId: 'p'
}

const live = { tabsByWorktree: { wt: [{ id: 'tab' }] }, ptyIdsByTabId: { tab: ['pty'] } }

describe('isHiddenBySidebarSwitch', () => {
  it('hides nothing while every switch is off', () => {
    expect(isHiddenBySidebarSwitch(row({ isMainWorktree: true }), REPO, inputs())).toBe(false)
  })

  it('hides each kind only under its own switch', () => {
    const cases: [Partial<Worktree>, Partial<SidebarSwitchInputs>][] = [
      [{ isMainWorktree: true, branch: 'refs/heads/main' }, { hideDefaultBranchWorkspace: true }],
      [{ automationProvenance: AUTOMATION }, { hideAutomationGeneratedWorkspaces: true }],
      [
        { cliProvenance: { kind: 'created-by-cli', createdAt: 0 } },
        { hideCliCreatedWorkspaces: true }
      ],
      [{ branch: '', head: 'abc1234' }, { hideDetachedHeadWorkspaces: true }]
    ]
    for (const [kind, on] of cases) {
      expect(isHiddenBySidebarSwitch(row(kind), REPO, inputs(on))).toBe(true)
      expect(isHiddenBySidebarSwitch(row(), REPO, inputs(on))).toBe(false)
    }
  })

  it('hides another client’s workspace under Hide other-client workspaces', () => {
    const fromHost = row({ creatorProvenance: { kind: 'paired-device', deviceId: 'phone' } })
    expect(
      isHiddenBySidebarSwitch(fromHost, REPO, inputs({ hideWorkspacesFromOtherDevices: true }))
    ).toBe(true)
    expect(isHiddenBySidebarSwitch(fromHost, REPO, inputs())).toBe(false)
  })

  it('hides a sleeping workspace but keeps a live one and the exempt main checkout', () => {
    const hideSleeping = { showSleepingWorkspaces: false }
    expect(isHiddenBySidebarSwitch(row(), REPO, inputs(hideSleeping))).toBe(true)
    expect(isHiddenBySidebarSwitch(row(), REPO, inputs({ ...hideSleeping, ...live }))).toBe(false)
    const main = row({ isMainWorktree: true })
    expect(isHiddenBySidebarSwitch(main, REPO, inputs(hideSleeping))).toBe(false)
    expect(
      isHiddenBySidebarSwitch(
        main,
        REPO,
        inputs({ ...hideSleeping, alwaysShowDefaultBranchWorkspace: false })
      )
    ).toBe(true)
  })

  it('lets Hide default branch win over the sleeping exemption', () => {
    const main = row({ isMainWorktree: true, branch: 'refs/heads/main' })
    expect(
      isHiddenBySidebarSwitch(
        main,
        REPO,
        inputs({ showSleepingWorkspaces: false, hideDefaultBranchWorkspace: true, ...live })
      )
    ).toBe(true)
  })
})

describe('isFolderWorkspaceHiddenBySidebarSwitch', () => {
  const folder: FolderWorkspace = {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'f1',
    folderPath: '/f1',
    creatorProvenance: { kind: 'paired-device', deviceId: 'phone' },
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }

  it('answers only the other-client switch', () => {
    expect(
      isFolderWorkspaceHiddenBySidebarSwitch(folder, {
        hideWorkspacesFromOtherDevices: true,
        pairedDeviceIdsByEnvironment: new Map()
      })
    ).toBe(true)
    expect(
      isFolderWorkspaceHiddenBySidebarSwitch(folder, {
        hideWorkspacesFromOtherDevices: false,
        pairedDeviceIdsByEnvironment: new Map()
      })
    ).toBe(false)
  })
})
