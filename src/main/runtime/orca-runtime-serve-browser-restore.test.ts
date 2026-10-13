import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { withOpenedServeBrowserTab } from './serve-browser-tab-layout'

/** A host with no window whose saved session holds a browser tab from a run before a restart. */
function restartedServe() {
  const saved = withOpenedServeBrowserTab('local', makeWorkspaceSessionWithHeadlessTerminal(), {
    worktreeId: TEST_WORKTREE_ID,
    pageId: 'page-1',
    url: 'https://example.com/',
    title: 'Example'
  })!
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  const livePages: string[] = []
  const createTab = vi.fn(async ({ browserPageId }: { browserPageId?: string }) => {
    livePages.push(browserPageId!)
    return { browserPageId: browserPageId! }
  })
  runtime.setOffscreenBrowserBackend({ createTab, closeTab: vi.fn(async () => {}) })
  runtime.setAgentBrowserBridge(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only tabList from the bridge on these paths.
    {
      tabList: vi.fn(() => ({
        tabs: livePages.map((browserPageId, index) => ({
          browserPageId,
          index,
          url: 'https://example.com/',
          title: 'Example',
          active: false
        }))
      }))
    } as never
  )
  return { runtime, createTab, getSession }
}

describe('a saved browser tab on a host with no window', () => {
  it('is listed after a restart without starting its page', async () => {
    const { runtime, createTab } = restartedServe()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs.find((tab) => tab.type === 'browser')).toMatchObject({
      id: 'page-1',
      browserPageId: 'page-1',
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('starts its page once, at its saved address, when a client opens it', async () => {
    const { runtime, createTab } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await Promise.all([
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1'),
      runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')
    ])

    expect(createTab).toHaveBeenCalledTimes(1)
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-1',
        url: 'https://example.com/',
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('is forgotten when a client closes it', async () => {
    const { runtime, getSession } = restartedServe()
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'page-1')

    expect(getSession().browserTabsByWorktree?.[TEST_WORKTREE_ID] ?? []).toEqual([])
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.some((tab) => tab.type === 'browser')).toBe(false)
  })

  it('starts its page for a command that names only the page', async () => {
    const { runtime, createTab } = restartedServe()

    expect(await runtime['serveBrowserTabs'].restore(undefined, 'page-1')).toBe(true)

    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-1', worktreeId: TEST_WORKTREE_ID })
    )
  })
})
