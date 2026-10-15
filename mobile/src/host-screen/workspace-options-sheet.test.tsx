import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('../components/MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))

import {
  WORKSPACE_VIEW_SECTION_LABELS,
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionContext
} from '../../../src/shared/workspace-view/workspace-view-options'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { DEFAULT_CARD_VIEW } from '../worktree/workspace-view-settings'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(options: { newCardStyle: boolean; hideSleeping: boolean }) {
  const settings = {
    clearFilters: vi.fn(),
    handleGroupChange: vi.fn(),
    handleSortChange: vi.fn(),
    setAgentActivityDisplayMode: vi.fn(),
    setCardLayout: vi.fn(),
    setFilter: vi.fn(),
    setProjectOrderBy: vi.fn(),
    toggleCardProperty: vi.fn(),
    toggleRepoFilter: vi.fn()
  }
  const controller = {
    activeFilterCount: 0,
    displayWorktrees: [],
    sectionsResult: {
      uniqueRepos: [
        { key: 'r1', id: 'r1', name: 'orca', color: '#fff' },
        { key: 'r2', id: 'r2', name: 'docs', color: '#000' }
      ]
    },
    settings,
    state: {
      cardSettings: { compactWorktreeCards: false, newCardStyle: options.newCardStyle },
      cardView: DEFAULT_CARD_VIEW,
      filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: options.hideSleeping },
      groupMode: 'repo',
      hostLabelById: new Map(),
      hostPlatform: null,
      repoHostIdByRepoId: new Map([['r2', 'ssh:box']]),
      serverWorkspaces: { hosts: [{ hostId: 'runtime:vm', label: 'VM' }], worktrees: [] },
      setShowFilterModal: vi.fn(),
      sharesOtherClientFilter: true,
      showFilterModal: true,
      sortMode: 'smart'
    }
  }
  act(() => {
    renderer = create(
      createElement(WorkspaceOptionsSheet, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these members.
        controller: controller as unknown as Parameters<
          typeof WorkspaceOptionsSheet
        >[0]['controller']
      })
    )
  })
  return settings
}

const texts = () =>
  renderer!.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')

// The first row with `label`, in menu order ("Compact" is a card layout before an activity layout).
const press = (label: string) =>
  renderer!.root
    .findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
    )[0]
    .props.onPress()

describe('the phone Workspace options sheet', () => {
  it.each([
    { newCardStyle: false, hideSleeping: true },
    { newCardStyle: true, hideSleeping: false }
  ])('renders every option the shared list shows (%o)', (options) => {
    render(options)
    const context: WorkspaceViewOptionContext = {
      groupBy: 'repo',
      hideSleepingWorkspaces: options.hideSleeping,
      hideWorkspacesFromOtherDevices: false,
      newCardStyle: options.newCardStyle,
      hasRemoteHosts: true,
      projectCount: 2,
      mayHaveServerHosts: true
    }
    const shown = texts()
    for (const { section, options: sectionOptions } of getShownWorkspaceViewSections(context)) {
      const sectionLabel = WORKSPACE_VIEW_SECTION_LABELS[section]
      if (sectionLabel) {
        expect(shown).toContain(sectionLabel)
      }
      for (const option of sectionOptions) {
        expect(shown).toContain(option.label)
      }
    }
    expect(shown.includes('Card display')).toBe(options.newCardStyle)
    expect(shown.includes('Except default branch')).toBe(options.hideSleeping)
  })

  it('writes each control to the shared value it names', () => {
    const settings = render({ newCardStyle: false, hideSleeping: false })
    press('Hide CLI-created')
    expect(settings.setFilter).toHaveBeenCalledWith('hideCliCreatedWorkspaces', true)
    press('Compact')
    expect(settings.setCardLayout).toHaveBeenCalledWith('compact')
    press('Recent')
    expect(settings.handleSortChange).toHaveBeenCalledWith('recent')
    press('VM')
    expect(settings.setFilter).toHaveBeenCalledWith('visibleHostIds', ['runtime:vm'])
  })
})
