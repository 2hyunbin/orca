// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_VIEW_OPTIONS,
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionContext
} from '../../../../shared/workspace-view/workspace-view-options'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const hostOptions: { id: string }[] = []
  return { state, hostOptions }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('./use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: mocks.hostOptions, hostScopeOptions: [] })
}))
vi.mock('./sidebar-host-options', () => ({
  shouldShowHostScopeControls: (hosts: { id: string }[]) => hosts.some((h) => h.id !== 'local'),
  getSidebarHostVisibilityLabel: () => 'All hosts'
}))
vi.mock('./SidebarHostScopeMenuSection', () => ({
  SidebarHostScopeMenuSection: () => <div data-option="hosts">Hosts</div>
}))
vi.mock('./SidebarRepositoryFilterSection', () => ({
  default: () => <div data-option="projects">Projects</div>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenuCheckboxItem: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: () => null,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuItem: Pass
  }
})

import { WorkspaceOptionsMenuItems } from './workspace-options-menu-items'

const BASE_CONTEXT: WorkspaceViewOptionContext = {
  groupBy: 'none',
  hideSleepingWorkspaces: false,
  hideWorkspacesFromOtherDevices: false,
  newCardStyle: false,
  hasRemoteHosts: false,
  projectCount: 1,
  mayHaveServerHosts: false
}

function setState(context: WorkspaceViewOptionContext): void {
  mocks.hostOptions = context.hasRemoteHosts ? [{ id: 'local' }, { id: 'ssh:box' }] : []
  const noop = vi.fn()
  mocks.state = {
    repos: Array.from({ length: context.projectCount }, (_, i) => ({ id: `repo-${i}` })),
    groupBy: context.groupBy,
    setGroupBy: noop,
    sortBy: 'name',
    setSortBy: noop,
    projectOrderBy: 'manual',
    setProjectOrderBy: noop,
    showSleepingWorkspaces: !context.hideSleepingWorkspaces,
    setShowSleepingWorkspaces: noop,
    alwaysShowDefaultBranchWorkspace: true,
    setAlwaysShowDefaultBranchWorkspace: noop,
    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: noop,
    hideAutomationGeneratedWorkspaces: false,
    setHideAutomationGeneratedWorkspaces: noop,
    hideCliCreatedWorkspaces: false,
    setHideCliCreatedWorkspaces: noop,
    hideDetachedHeadWorkspaces: false,
    setHideDetachedHeadWorkspaces: noop,
    hideWorkspacesFromOtherDevices: context.hideWorkspacesFromOtherDevices,
    setHideWorkspacesFromOtherDevices: noop,
    runtimeEnvironments: context.mayHaveServerHosts ? [{ id: 'server' }] : [],
    runtimeEnvironmentCatalogHydrated: true,
    settings: {
      compactWorktreeCards: false,
      experimentalNewWorktreeCardStyle: context.newCardStyle
    },
    worktreeCardProperties: ['status'],
    setWorktreeCardProperties: noop,
    setWorktreeCardMode: noop,
    agentActivityDisplayMode: 'compact',
    setAgentActivityDisplayMode: noop,
    projectGroups: [],
    visibleWorkspaceHostIds: null,
    setVisibleWorkspaceHostIds: noop,
    setWorkspaceHostScope: noop
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Every descriptor label the menu shows, in document order. */
function renderedOptionLabels(): string[] {
  const text = container.textContent ?? ''
  return WORKSPACE_VIEW_OPTIONS.filter((option) => text.includes(option.label))
    .map((option) => ({ label: option.label, at: text.indexOf(option.label) }))
    .sort((a, b) => a.at - b.at)
    .map((option) => option.label)
}

const CONTEXTS: WorkspaceViewOptionContext[] = [
  BASE_CONTEXT,
  {
    ...BASE_CONTEXT,
    groupBy: 'repo',
    hideSleepingWorkspaces: true,
    hasRemoteHosts: true,
    projectCount: 3,
    mayHaveServerHosts: true
  },
  { ...BASE_CONTEXT, newCardStyle: true, hideWorkspacesFromOtherDevices: true }
]

describe('Workspace options menu renders from the shared option list', () => {
  for (const context of CONTEXTS) {
    it(`shows one control per shown option, in order: ${JSON.stringify(context)}`, () => {
      setState(context)
      act(() => root.render(<WorkspaceOptionsMenuItems />))
      const expected = getShownWorkspaceViewSections(context).flatMap(({ options }) =>
        options.map((option) => option.label)
      )
      expect(renderedOptionLabels()).toEqual(expected)
    })
  }

  it('renders every option in some context', () => {
    const everShown = new Set(
      CONTEXTS.flatMap((context) =>
        getShownWorkspaceViewSections(context).flatMap(({ options }) =>
          options.map((option) => option.key)
        )
      )
    )
    expect([...everShown].sort()).toEqual(WORKSPACE_VIEW_OPTIONS.map((o) => o.key).sort())
  })
})
