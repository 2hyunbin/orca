/**
 * A client-hosted browser page's tab is added by the runtime, never by the window, so the window's
 * session saves omit it. Until 6g the holder reloads those saves; a live page's row must survive.
 */
import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const WORKTREE = `id:${TEST_WORKTREE_ID}`
const placement = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 9
}

/** The window's own save: its terminal tab and a second one in one group, no client page. */
function windowSession(): WorkspaceSessionState {
  const tab = (id: string, sortOrder: number) => ({
    id,
    entityId: id,
    groupId: 'group',
    worktreeId: TEST_WORKTREE_ID,
    contentType: 'terminal' as const,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  })
  return makeWorkspaceSessionWithHeadlessTerminal({
    unifiedTabs: { [TEST_WORKTREE_ID]: [tab('host-tab', 0)] },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'group',
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        }
      ]
    }
  })
}

function windowHostWithClientPage(pageId = 'page-client') {
  const harness = makeRuntimeStoreWithWorkspaceSession(windowSession())
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const pages = getRuntimeBrowserPageRegistry(runtime)
  pages.publishClientPage({
    browserPageId: pageId,
    workspaceId: TEST_WORKTREE_ID,
    browserProfileId: 'profile-a',
    executionHostKey: 'execution-a',
    placement,
    url: 'https://remote.internal/',
    loading: false,
    active: true
  })
  // What a client page's create adds (publishCreatedBrowserSessionTab).
  runtime.addHeadlessBrowserLayoutTab(TEST_WORKTREE_ID, pageId, 'group')
  /** The window saves its session again (it never learns of the client page). */
  const windowSaves = (session: WorkspaceSessionState = windowSession()): void => {
    harness.setSession(session)
  }
  return { harness, runtime, pages, windowSaves }
}

async function browserRows(runtime: OrcaRuntimeService) {
  return (await runtime.listMobileSessionTabs(WORKTREE)).tabs.filter(
    (tab) => tab.type === 'browser'
  )
}

describe("a live client-hosted browser page across the window's session saves", () => {
  it("keeps the page's row and the window's own rows", async () => {
    const { runtime, windowSaves } = windowHostWithClientPage()

    windowSaves()

    const tabs = (await runtime.listMobileSessionTabs(WORKTREE)).tabs
    expect(tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'terminal', parentTabId: 'host-tab' }),
        expect.objectContaining({ type: 'browser', browserPageId: 'page-client', placement })
      ])
    )
  })

  it('keeps the tab in its group at its place', async () => {
    const { runtime, windowSaves } = windowHostWithClientPage()
    const before = runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.groups

    windowSaves()

    expect(runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.groups).toEqual(before)
    expect(before?.[0]?.tabOrder).toHaveLength(2)
  })

  it('drops the row once the page is retired', async () => {
    const { runtime, pages, windowSaves } = windowHostWithClientPage()
    windowSaves()
    expect(await browserRows(runtime)).toHaveLength(1)

    expect(pages.retirePage('page-client', placement)).toBe(true)
    windowSaves()

    expect(await browserRows(runtime)).toEqual([])
    expect(
      runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.tabs.some((tab) => tab.kind === 'browser')
    ).toBe(false)
  })

  it('never lists the row twice when the save carries the tab itself', async () => {
    const { harness, runtime, windowSaves } = windowHostWithClientPage()

    windowSaves(structuredClone(harness.getSession()))

    expect(await browserRows(runtime)).toHaveLength(1)
    expect(
      runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.tabs.filter((tab) => tab.kind === 'browser')
    ).toHaveLength(1)
  })

  it('does not keep a browser tab whose page is not client-hosted', async () => {
    const { runtime, windowSaves } = windowHostWithClientPage()
    // A page of another host kind: the registry does not hold it, so the save decides.
    runtime.addHeadlessBrowserLayoutTab(TEST_WORKTREE_ID, 'page-renderer', 'group')
    expect(
      runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.tabs.filter((tab) => tab.kind === 'browser')
    ).toHaveLength(2)

    windowSaves()

    expect(
      runtime
        .heldWorkspaceLayout(TEST_WORKTREE_ID)
        ?.tabs.filter((tab) => tab.kind === 'browser')
        .map((tab) => tab.entityId)
    ).toEqual(['page-client'])
  })
})
