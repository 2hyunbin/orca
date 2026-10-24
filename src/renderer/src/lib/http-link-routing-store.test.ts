import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { useAppStore } from '@/store'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { seedBrowserLinkTestStore, WORKSPACE, URL_TO_OPEN } from './browser-link-open-test-harness'
import { captureLinkOpenIntent } from './link-open-intent'
import { openHttpLink } from './http-link-routing'
import * as workspaceBrowserTabOpen from './workspace-browser-tab-open'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))

beforeEach(() => {
  createStoreCascadesMockApi()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    activeView: 'activity',
    settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true }
  })
  vi.mocked(requestBrowserFocus).mockClear()
})
afterEach(() => vi.restoreAllMocks())

it.each([false, true])(
  'reveals the tab layout for a foreground source-aware HTTP link (reuse: %s)',
  async (reuse) => {
    if (reuse) {
      useAppStore.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
        targetGroupId: 'b',
        activate: false,
        browserRuntimeEnvironmentId: null,
        sessionProfileId: null
      })
    }
    const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
    openHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceOwner: { kind: 'local' },
      linkContext: {
        linkIntent: captureLinkOpenIntent(useAppStore.getState(), WORKSPACE, 'source')
      }
    })
    await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
    const outcome = await opening.mock.results[0]!.value

    expect(outcome).toMatchObject({ status: 'opened', result: { groupId: 'b' } })
    expect(useAppStore.getState().activeView).toBe('terminal')
    expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('b')
    expect(useAppStore.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(1)
  }
)

it('keeps the Activity view and current pane selected for background source-aware HTTP links', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      openLinksInApp: true,
      openLinksInAppInBackground: true
    }
  })
  const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
  openHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceOwner: { kind: 'local' },
    linkContext: { linkIntent: captureLinkOpenIntent(useAppStore.getState(), WORKSPACE, 'source') }
  })
  await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
  expect(await opening.mock.results[0]!.value).toMatchObject({ status: 'opened' })
  expect(useAppStore.getState().activeView).toBe('activity')
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
  expect(useAppStore.getState().activeGroupIdByWorktree[WORKSPACE]).toBe('c')
  expect(requestBrowserFocus).not.toHaveBeenCalled()
})

it('keeps the main view and workspace selected when revealing a floating HTTP link', async () => {
  const floating = FLOATING_TERMINAL_WORKTREE_ID
  const state = useAppStore.getState()
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      openLinksInApp: true,
      floatingTerminalEnabled: true
    },
    floatingWorkspacePanelOpen: true,
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [floating]: state.groupsByWorktree[WORKSPACE]!.map((group) => ({
        ...group,
        worktreeId: floating
      }))
    },
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [floating]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        ...tab,
        worktreeId: floating
      }))
    },
    layoutByWorktree: { ...state.layoutByWorktree, [floating]: state.layoutByWorktree[WORKSPACE]! }
  })
  const opening = vi.spyOn(workspaceBrowserTabOpen, 'openWorkspaceBrowserTabForLink')
  openHttpLink(URL_TO_OPEN, {
    worktreeId: floating,
    sourceOwner: { kind: 'local' },
    linkContext: { linkIntent: captureLinkOpenIntent(useAppStore.getState(), floating, 'source') }
  })
  await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce())
  expect(await opening.mock.results[0]!.value).toMatchObject({ status: 'opened' })
  expect(useAppStore.getState().activeView).toBe('activity')
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
  expect(useAppStore.getState().activeGroupIdByWorktree[floating]).toBe('b')
})
