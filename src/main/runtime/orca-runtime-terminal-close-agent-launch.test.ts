import { afterEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'
import {
  LEAF_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  TAB_ID,
  WORKTREE_ID,
  createHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

afterEach(() => {
  resetAgentLaunchPanesForTests()
  setRuntimeDesktopSurface(null)
})

function launchIn(leafId: string) {
  return trackRunningAgentLaunchPane({
    worktreeId: WORKTREE_ID,
    paneKey: makePaneKey(TAB_ID, leafId)
  })
}

function showDesktopWindow(): void {
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane close path only checks window and WebContents destruction.
      return { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as never
    },
    onIpc: () => {},
    removeIpcListener: () => {}
  })
}

describe("a pane close main starts (a phone's, the CLI's)", () => {
  // The holder closes the pane whether or not a window is attached.
  it.each([
    { host: 'with a desktop window', desktop: true },
    { host: 'with no desktop window', desktop: false }
  ])('stops a launch still running in that pane, and only that one, $host', async ({ desktop }) => {
    if (desktop) {
      showDesktopWindow()
    }
    const harness = createHarness({ publishMobileSurface: true })
    harness.syncSplitFixtureGraph()
    const closed = launchIn(LEAF_ID)
    const sibling = launchIn(SIBLING_LEAF_ID)
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )
    if (!terminal) {
      throw new Error('fixture pane has no terminal handle')
    }

    await harness.runtime.closeTerminal(terminal.handle)

    expect(
      (await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs.map((tab) => tab.id)
    ).toEqual([`${TAB_ID}::${SIBLING_LEAF_ID}`])
    expect(closed.closedByUser()).toBe(true)
    expect(sibling.closedByUser()).toBe(false)
  })
})
