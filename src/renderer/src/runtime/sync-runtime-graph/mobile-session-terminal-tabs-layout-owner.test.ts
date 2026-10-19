import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { buildMobileTerminalSurfaceTabs } from './mobile-session-terminal-tabs'
import type { MobileSessionWorktreeInputs, MountedTerminalSurfaceCapture } from './types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE_ID = 'repo-1::/workspace'
const TAB_ID = 'tab-1'
const MOUNTED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF_ID = '22222222-2222-4222-8222-222222222222'

// Main's tree after a main-side split: the window drew it from the frame before mounting the pane.
const mainLayout: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: MOUNTED_LEAF_ID },
    second: { type: 'leaf', leafId: NEW_LEAF_ID }
  },
  activeLeafId: MOUNTED_LEAF_ID,
  expandedLeafId: null,
  ptyIdsByLeafId: { [MOUNTED_LEAF_ID]: 'pty-mounted', [NEW_LEAF_ID]: 'pty-new' }
}

const capture: MountedTerminalSurfaceCapture = {
  paneLeafIds: [MOUNTED_LEAF_ID],
  hasLiveActivePane: true,
  liveActiveLeafId: MOUNTED_LEAF_ID,
  liveLayoutRoot: { type: 'leaf', leafId: MOUNTED_LEAF_ID },
  numericPaneIdByLeafId: new Map([[MOUNTED_LEAF_ID, 1]]),
  ptyIdByNumericPaneId: new Map([[1, 'pty-mounted']]),
  tabWideAgentHintLeafId: null
}

const terminal = {
  id: TAB_ID,
  ptyId: 'pty-mounted',
  worktreeId: WORKTREE_ID,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function inputs(): MobileSessionWorktreeInputs {
  return {
    worktreeId: WORKTREE_ID,
    worktreeInstanceId: undefined,
    terminalTabs: [terminal],
    browserWorkspaces: [],
    unifiedTabs: [],
    groups: [],
    tabBarOrder: undefined,
    activeGroupId: null,
    tabGroupLayout: undefined,
    openFilesById: undefined,
    openFileIds: [],
    terminalLayoutByTabId: new Map([[TAB_ID, mainLayout]]),
    paneTitlesByTabId: new Map(),
    launchDraftByPaneKey: new Map(),
    agentStatusByPaneKey: new Map(),
    editorDraftVersionByFileId: new Map(),
    pagesByBrowserWorkspaceId: new Map(),
    certificateFailureByBrowserPageId: new Map(),
    activeEditorFileId: null,
    activeEditorTabType: null,
    activeTerminalTabId: TAB_ID,
    activeBrowserWorkspaceId: null,
    generatedTitlesEnabled: false,
    terminalTheme: undefined,
    mountedSurfaceCaptureByTabId: new Map([[TAB_ID, capture]])
  }
}

describe("a mounted tab's terminal surfaces, in a layout-owner build", () => {
  it('lists a pane main holds that the window has not mounted yet, with its terminal', () => {
    const surfaces = buildMobileTerminalSurfaceTabs(inputs(), terminal).flatMap((surface) =>
      surface.type === 'terminal' ? [surface] : []
    )

    expect(surfaces.map((surface) => [surface.leafId, surface.ptyId])).toEqual([
      [MOUNTED_LEAF_ID, 'pty-mounted'],
      [NEW_LEAF_ID, 'pty-new']
    ])
    expect(surfaces[1]?.parentLayout?.root).toEqual(mainLayout.root)
  })
})
