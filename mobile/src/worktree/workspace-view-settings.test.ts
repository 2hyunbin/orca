import { describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  groupModeFromDesktop,
  groupModeToDesktop,
  sortModeFromDesktop,
  NO_FILTERS,
  type MobileViewState,
  type WorkspaceViewSettings
} from './workspace-view-settings'

const base: MobileViewState = {
  groupMode: 'repo',
  sortMode: 'recent',
  filters: { ...NO_FILTERS, alwaysShowDefaultBranchWorkspace: false },
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

  it('leaves host scope out of the view state; the screen keeps the shown hosts apart', () => {
    const next = applyDesktopViewSettings(base, {
      workspaceHostScope: 'runtime:devbox',
      visibleWorkspaceHostIds: ['local']
    } as unknown as WorkspaceViewSettings)

    expect(next).toEqual(base)
  })

  it('ignores an unrecognized groupBy rather than blanking the mode', () => {
    const next = applyDesktopViewSettings(base, { groupBy: 'mystery' as never })
    expect(next.groupMode).toBe('repo')
  })
})

describe('buildWorkspaceViewSettingsUpdate', () => {
  const withFilters = (filters: Partial<MobileViewState['filters']>): MobileViewState => ({
    ...base,
    filters: { ...base.filters, ...filters }
  })

  it('carries only the fields the patch touched (STA-5781)', () => {
    const hidden = withFilters({ hideSleepingWorkspaces: true })
    expect(buildWorkspaceViewSettingsUpdate({ filters: hidden.filters }, hidden, base)).toEqual({
      hideSleepingWorkspaces: true
    })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { groupMode: 'workspaceStatus' },
        { ...base, groupMode: 'workspaceStatus' },
        base
      )
    ).toEqual({ groupBy: 'workspace-status' })
    expect(
      buildWorkspaceViewSettingsUpdate(
        { collapsedGroups: ['g1'] },
        { ...base, collapsedGroups: ['g1'] },
        base
      )
    ).toEqual({ collapsedGroups: ['g1'] })
  })

  it('writes each filter the phone now shares under its desktop name', () => {
    const next = withFilters({
      hideAutomationGeneratedWorkspaces: true,
      hideWorkspacesFromOtherDevices: true
    })
    expect(buildWorkspaceViewSettingsUpdate({ filters: next.filters }, next, base)).toEqual({
      hideAutomationGeneratedWorkspaces: true,
      hideWorkspacesFromOtherDevices: true
    })
  })

  it('maps a reset without dragging untouched siblings along', () => {
    const previous = withFilters({ hideSleepingWorkspaces: true, filterRepoIds: ['repo-1'] })
    const update = buildWorkspaceViewSettingsUpdate({ filters: base.filters }, base, previous)
    expect(update).toEqual({ hideSleepingWorkspaces: false, filterRepoIds: [] })
  })

  it('never invents alwaysShowDefaultBranchWorkspace for edits that leave it alone (#8873)', () => {
    const next = withFilters({ hideSleepingWorkspaces: true })
    expect(
      'alwaysShowDefaultBranchWorkspace' in
        buildWorkspaceViewSettingsUpdate({ filters: next.filters }, next, base)
    ).toBe(false)
  })

  it('returns an empty update for an empty patch', () => {
    expect(buildWorkspaceViewSettingsUpdate({}, base, base)).toEqual({})
  })
})
