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

import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
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
    projectOrderBy: 'manual',
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
      view: {
        ...INITIAL_MOBILE_VIEW,
        filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: options.hideSleeping },
        groupBy: 'repo',
        sortBy: 'smart',
        sharesOtherClientFilter: true
      },
      hostLabelById: new Map(),
      hostPlatform: null,
      repoHostIdByRepoId: new Map([['r2', 'ssh:box']]),
      serverWorkspaces: { hosts: [{ hostId: 'runtime:vm', label: 'VM' }], worktrees: [] },
      setShowWorkspaceOptions: vi.fn(),
      showWorkspaceOptions: true
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

/** Taps the row named `label`, inside one option's card when `option` is given. */
const press = (label: string, option?: string) => {
  const scope = option
    ? renderer!.root.find((node) => node.props.testID === `workspace-option-${option}`)
    : renderer!.root
  scope
    .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label)
    .props.onPress()
}

describe('the phone Workspace options sheet', () => {
  it('shows the classic card options and the default-branch exemption while sleeping ones hide', () => {
    render({ newCardStyle: false, hideSleeping: true })
    const shown = texts()
    for (const label of [
      'Show',
      'Hosts',
      'Projects',
      'Group by',
      'Sort by',
      'Project order',
      'Card layout',
      'Show properties',
      'Agent activity layout',
      'Filters',
      'Hide sleeping',
      'Except default branch',
      'Hide other-client workspaces',
      'Hide detached HEAD'
    ]) {
      expect(shown).toContain(label)
    }
    expect(shown).not.toContain('Card display')
  })

  it('swaps in Card display for the new card style and drops the exemption when nothing sleeps', () => {
    render({ newCardStyle: true, hideSleeping: false })
    const shown = texts()
    expect(shown).toContain('Card display')
    expect(shown).not.toContain('Card layout')
    expect(shown).not.toContain('Show properties')
    expect(shown).not.toContain('Except default branch')
  })

  it('writes each control to the shared value it names', () => {
    const settings = render({ newCardStyle: false, hideSleeping: false })
    press('Hide CLI-created')
    expect(settings.setFilter).toHaveBeenCalledWith('hideCliCreatedWorkspaces', true)
    press('Compact', 'cardLayout')
    expect(settings.setCardLayout).toHaveBeenCalledWith('compact')
    press('Recent', 'sortBy')
    expect(settings.handleSortChange).toHaveBeenCalledWith('recent')
    press('Recent', 'projectOrderBy')
    expect(settings.setProjectOrderBy).toHaveBeenCalledWith('recent')
    press('VM', 'hosts')
    expect(settings.setFilter).toHaveBeenCalledWith('visibleHostIds', ['runtime:vm'])
  })
})
