/**
 * A page a paired client runs for a host with no window is saved as a browser tab in the host's
 * layout, like the host's own tabs: losing the client keeps it, a close removes it, and the host
 * never starts it itself.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { OrcaRuntimeService } from './orca-runtime'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const WT = 'repo-1::/tmp/worktree-a'
const repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

function createProfile() {
  const session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const state = { session }
  const store = {
    getRepo: () => repo,
    getRepos: () => [repo],
    addRepo: () => {},
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    removeWorktreeMeta: () => {},
    getSettings: () => ({ workspaceDir: '/tmp/workspaces', nestWorkspaces: false }),
    getWorkspaceSession: () => state.session,
    getWorkspaceSessionHostIds: () => ['local' as const],
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      state.session = next
    }
  }
  return { state, store }
}

function savedTabIds(state: { session: WorkspaceSessionState }): string[] {
  return (state.session.browserTabsByWorktree?.[WT] ?? []).map((tab) => tab.id)
}

function startClientPage(runtime: OrcaRuntimeService, browserPageId: string) {
  getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-host-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview']
  })
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage(browserPageId, 'host-a')
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: WT,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:1',
    placement,
    pairedDeviceId: 'device-a',
    url: 'https://example.internal/docs',
    title: 'Internal docs',
    loading: false,
    active: true
  })
  runtime.notifyMobileSessionTabsChanged(WT)
  return placement
}

describe('a client-hosted page on a host with no window', () => {
  it('is saved as a browser tab at its last address', () => {
    const { state, store } = createProfile()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on this path.
    const runtime = new OrcaRuntimeService(store as never, undefined, {})

    const placement = startClientPage(runtime, 'page-a')
    expect(savedTabIds(state)).toEqual(['page-a'])

    getRuntimeBrowserPageRegistry(runtime).updatePage('page-a', placement, {
      url: 'https://example.internal/next',
      title: 'Next'
    })
    runtime.notifyMobileSessionTabsChanged(WT)
    expect(state.session.browserPagesByWorkspace?.['page-a']).toEqual([
      expect.objectContaining({ url: 'https://example.internal/next', title: 'Next' })
    ])
  })

  it('keeps its saved tab when the client goes away, and the host does not start it', async () => {
    const { state, store } = createProfile()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on this path.
    const first = new OrcaRuntimeService(store as never, undefined, {})
    startClientPage(first, 'page-a')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on this path.
    const replacement = new OrcaRuntimeService(store as never, undefined, {})
    replacement.rehydrateClientHostedBrowserPages()
    replacement.notifyMobileSessionTabsChanged(WT)

    expect(savedTabIds(state)).toEqual(['page-a'])
    expect(replacement['serveBrowserTabs'].listRestorable(WT)).toEqual([])
    expect(await replacement['serveBrowserTabs'].restore(WT, 'page-a')).toBe(false)
  })

  it('loses its saved tab when the user closes it', () => {
    const { state, store } = createProfile()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on this path.
    const runtime = new OrcaRuntimeService(store as never, undefined, {})
    const placement = startClientPage(runtime, 'page-a')

    // What every close of a client page ends in once the page is retired.
    getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', placement)
    runtime.retireRuntimeOwnedBrowserSessionTab(WT, 'page-a')

    expect(savedTabIds(state)).toEqual([])
  })
})
