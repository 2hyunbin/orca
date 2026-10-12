import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileTerminalTheme
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

const theme: RuntimeMobileTerminalTheme = {
  mode: 'light',
  theme: { background: '#ffffff', foreground: '#000000' }
}

function windowRows(
  extra: { terminalTheme?: RuntimeMobileTerminalTheme; launchDraft?: string } = {}
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'window',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `host-tab::${HEADLESS_LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        title: 'Persisted Terminal',
        isActive: true,
        ...(extra.terminalTheme ? { terminalTheme: extra.terminalTheme } : {}),
        ...(extra.launchDraft ? { launchDraft: extra.launchDraft, launchDraftCreatedAt: 42 } : {})
      }
    ]
  }
}

function terminalRow(listed: RuntimeMobileSessionTabsResult) {
  return listed.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab')
}

describe("the window's terminal theme and launch drafts while it keeps its own paths (until 6e)", () => {
  it('lists the theme and launch draft the window publishes on its terminal rows', async () => {
    const harness = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const runtime = new OrcaRuntimeService(harness.runtimeStore)
    runtime.attachWindow(1)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [windowRows({ terminalTheme: theme, launchDraft: 'fix the build' })]
    })

    expect(terminalRow(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual(
      expect.objectContaining({
        terminalTheme: theme,
        launchDraft: 'fix the build',
        launchDraftCreatedAt: 42
      })
    )
  })

  it('drops a launch draft the window no longer publishes and announces the change', async () => {
    const harness = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
    const runtime = new OrcaRuntimeService(harness.runtimeStore)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [windowRows({ terminalTheme: theme, launchDraft: 'fix the build' })]
    })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [windowRows({ terminalTheme: theme })]
    })

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(terminalRow(after)).toEqual(expect.objectContaining({ terminalTheme: theme }))
    expect(terminalRow(after)).not.toHaveProperty('launchDraft')
    expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
  })
})
