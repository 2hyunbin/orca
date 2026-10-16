import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

class WindowedRuntime extends OrcaRuntimeService {
  protected override getAvailableAuthoritativeWindow(): ReturnType<
    OrcaRuntimeService['getAuthoritativeWindow']
  > {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test only checks that a window exists.
    return {} as ReturnType<OrcaRuntimeService['getAuthoritativeWindow']>
  }
}

function setup() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the store methods these paths call.
  const runtime = new WindowedRuntime(runtimeStore as never)
  const setSessionTabAppearance = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setMobileSessionTabProps calls only this notifier method.
  runtime.setNotifier({ setSessionTabAppearance } as never)
  const isPersistedPinned = (): boolean | undefined =>
    getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find((tab) => tab.id === 'host-tab')!.isPinned
  return { runtime, setSessionTabAppearance, isPersistedPinned }
}

describe('OrcaRuntimeService.setMobileSessionTabProps with a window open', () => {
  it("forwards a phone's pin and color to the window instead of dropping them", async () => {
    const { runtime, setSessionTabAppearance, isPersistedPinned } = setup()
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:1',
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
              title: 'Terminal',
              isActive: true
            }
          ]
        }
      ]
    })

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: `host-tab::${HEADLESS_LEAF_ID}`,
      color: '#ff8800',
      isPinned: true
    })

    expect(setSessionTabAppearance).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      tabId: 'host-tab',
      color: '#ff8800',
      isPinned: true
    })
    // The window owns these props and republishes them; a headless write would race it.
    expect(isPersistedPinned()).not.toBe(true)
  })

  it('does not forward a view-mode-only change to the window', async () => {
    const { runtime, setSessionTabAppearance } = setup()

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      viewMode: 'chat'
    })

    expect(setSessionTabAppearance).not.toHaveBeenCalled()
  })
})
