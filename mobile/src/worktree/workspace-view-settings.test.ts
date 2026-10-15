import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  changedFilters,
  groupModeFromDesktop,
  groupModeToDesktop,
  sortModeFromDesktop,
  DEFAULT_CARD_VIEW,
  type MobileViewState
} from './workspace-view-settings'

const base: MobileViewState = {
  groupMode: 'repo',
  sortMode: 'recent',
  filters: { ...NO_WORKSPACE_ROW_FILTERS, alwaysShowDefaultBranchWorkspace: false },
  ...DEFAULT_CARD_VIEW,
  collapsedGroups: [],
  workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES
}

describe('group mode mapping', () => {
  it('round-trips every mobile group mode through the desktop value', () => {
    for (const mode of ['none', 'workspaceStatus', 'repo', 'prStatus'] as const) {
      expect(groupModeFromDesktop(groupModeToDesktop(mode))).toBe(mode)
    }
  })

  it('maps the desktop kebab-case values back to mobile', () => {
    expect(groupModeFromDesktop('workspace-status')).toBe('workspaceStatus')
    expect(groupModeFromDesktop('pr-status')).toBe('prStatus')
    expect(groupModeFromDesktop(undefined)).toBeNull()
  })
})

describe('sort mode mapping', () => {
  it('accepts shared sort values and rejects unknown', () => {
    expect(sortModeFromDesktop('manual')).toBe('manual')
    expect(sortModeFromDesktop('smart')).toBe('smart')
    expect(sortModeFromDesktop(undefined)).toBeNull()
    expect(sortModeFromDesktop('bogus' as never)).toBeNull()
  })
})

describe('applyDesktopViewSettings', () => {
  it('applies provided desktop fields and leaves missing ones untouched', () => {
    const next = applyDesktopViewSettings(base, {
      groupBy: 'pr-status',
      hideSleepingWorkspaces: true,
      filterRepoIds: ['repo-1']
    })
    expect(next).toEqual({
      ...base,
      groupMode: 'prStatus',
      filters: { ...base.filters, hideSleepingWorkspaces: true, filterRepoIds: ['repo-1'] }
    })
  })

  it('keeps current values when the desktop payload is empty', () => {
    expect(applyDesktopViewSettings(base, {})).toEqual(base)
  })

  it('keeps renderable workspace statuses when desktop sends an empty catalog', () => {
    const next = applyDesktopViewSettings(base, { workspaceStatuses: [] })

    expect(next.workspaceStatuses).toBe(DEFAULT_MOBILE_WORKSPACE_STATUSES)
  })

  it("reads the desktop's shown hosts into the host filter, and null as every host", () => {
    const scoped = applyDesktopViewSettings(base, { visibleWorkspaceHostIds: ['local'] })
    expect(scoped.filters.visibleHostIds).toEqual(['local'])
    expect(
      applyDesktopViewSettings(scoped, { visibleWorkspaceHostIds: null }).filters.visibleHostIds
    ).toBeNull()
  })

  it('ignores an unrecognized groupBy rather than blanking the mode', () => {
    const next = applyDesktopViewSettings(base, { groupBy: 'mystery' as never })
    expect(next.groupMode).toBe('repo')
  })
})

describe('buildWorkspaceViewSettingsUpdate', () => {
  const apply = (filters: Partial<MobileViewState['filters']>): MobileViewState => ({
    ...base,
    filters: { ...base.filters, ...filters }
  })

  it('carries only the fields the patch touched (STA-5781)', () => {
    expect(
      buildWorkspaceViewSettingsUpdate(
        { filters: { hideSleepingWorkspaces: true } },
        apply({ hideSleepingWorkspaces: true })
      )
    ).toEqual({ hideSleepingWorkspaces: true })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { groupMode: 'workspaceStatus' },
        { ...base, groupMode: 'workspaceStatus' }
      )
    ).toEqual({ groupBy: 'workspace-status' })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { collapsedGroups: ['g1'] },
        { ...base, collapsedGroups: ['g1'] }
      )
    ).toEqual({ collapsedGroups: ['g1'] })
  })

  it('writes each filter under its desktop name, the host scope included', () => {
    const filters = {
      hideAutomationGeneratedWorkspaces: true,
      visibleHostIds: ['local' as const]
    }
    expect(buildWorkspaceViewSettingsUpdate({ filters }, apply(filters))).toEqual({
      hideAutomationGeneratedWorkspaces: true,
      visibleWorkspaceHostIds: ['local']
    })
  })

  it('sends every filter a full reset names, even ones the phone already thinks are off', () => {
    const update = buildWorkspaceViewSettingsUpdate(
      { filters: NO_WORKSPACE_ROW_FILTERS },
      apply(NO_WORKSPACE_ROW_FILTERS)
    )
    expect(update).toEqual({
      hideSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: true,
      hideDefaultBranchWorkspace: false,
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      hideDetachedHeadWorkspaces: false,
      hideWorkspacesFromOtherDevices: false,
      filterRepoIds: [],
      visibleWorkspaceHostIds: null
    })
  })

  it('never invents alwaysShowDefaultBranchWorkspace for edits that leave it alone (#8873)', () => {
    expect(
      'alwaysShowDefaultBranchWorkspace' in
        buildWorkspaceViewSettingsUpdate(
          { filters: { hideSleepingWorkspaces: true } },
          apply({ hideSleepingWorkspaces: true })
        )
    ).toBe(false)
  })

  it('returns an empty update for an empty patch', () => {
    expect(buildWorkspaceViewSettingsUpdate({}, base)).toEqual({})
  })
})

describe('changedFilters', () => {
  it('names only the filters that differ, so Clear never sends a field an older host lacks', () => {
    const current = {
      ...NO_WORKSPACE_ROW_FILTERS,
      hideSleepingWorkspaces: true,
      filterRepoIds: ['r1'],
      visibleHostIds: null
    }
    expect(changedFilters(current, NO_WORKSPACE_ROW_FILTERS)).toEqual({
      hideSleepingWorkspaces: false,
      filterRepoIds: []
    })
    expect(changedFilters(NO_WORKSPACE_ROW_FILTERS, { ...NO_WORKSPACE_ROW_FILTERS })).toEqual({})
  })
})

describe('card view settings', () => {
  it('reads the shared card values and writes a hand-picked property set as no longer a preset', () => {
    const next = applyDesktopViewSettings(base, {
      projectOrderBy: 'recent',
      worktreeCardProperties: ['pr'],
      agentActivityDisplayMode: 'full'
    })
    expect([
      next.projectOrderBy,
      next.worktreeCardProperties,
      next.agentActivityDisplayMode
    ]).toEqual(['recent', ['pr'], 'full'])
    expect(
      buildWorkspaceViewSettingsUpdate(
        { worktreeCardProperties: ['pr', 'host'] },
        {
          ...next,
          worktreeCardProperties: ['pr', 'host']
        }
      )
    ).toEqual({ worktreeCardProperties: ['pr', 'host'], _worktreeCardModeDefaulted: false })
  })
})
